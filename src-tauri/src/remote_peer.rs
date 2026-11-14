//! Cockpit Remote, phone side: pair with a Mac from its QR text, then open the pinned link,
//! catch up after a cursor, follow live rows and send allowlisted commands. The Tauri 2 iOS app
//! reuses this; until then `Cockpit --remote-peer` drives it from a terminal (and the self-test).

use std::time::Duration;

use iroh::endpoint::{Connection, SendStream};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::mpsc;

use crate::remote::{read_frame, write_frame};
use crate::remote_proto::{self as proto, Command, Frame, Known, Offer};

pub struct Peer {
    ep: Endpoint,
}

impl Peer {
    /// `local`: no relays or discovery (tests on one machine).
    pub async fn bind(key: SecretKey, local: bool) -> Result<Self, String> {
        let ep = if local {
            Endpoint::builder(iroh::endpoint::presets::Minimal).secret_key(key).bind().await
        } else {
            Endpoint::builder(iroh::endpoint::presets::N0).secret_key(key).bind().await
        }
        .map_err(|e| e.to_string())?;
        Ok(Self { ep })
    }

    /// Pairs with the Mac in `offer`. `on_code` gets the 6-digit code to compare with the Mac's
    /// screen; returns the Mac's name once you confirmed there.
    pub async fn pair(&self, offer: &Offer, name: &str, on_code: impl FnOnce(&str)) -> Result<String, String> {
        if offer.expires_at <= proto::now_ms() {
            return Err("this pairing code expired; show a new one on the Mac".into());
        }
        let secret = offer.secret_bytes()?;
        let conn = self.ep.connect(offer.mac.clone(), proto::ALPN_PAIR).await.map_err(|e| e.to_string())?;
        let mac_key = *conn.remote_id().as_bytes();
        let (mut send, recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        let mut recv = BufReader::new(recv);
        let proof = proto::pair_proof(&secret, &mac_key, self.ep.id().as_bytes());
        write_frame(&mut send, &Frame::Pair { proof, name: name.into() }).await?;
        let expect = proto::short_code(&secret, &mac_key, self.ep.id().as_bytes());
        let mut on_code = Some(on_code);
        let out = loop {
            match read_frame(&mut recv).await {
                Ok(Some(Frame::Confirm { code })) => {
                    if code != expect {
                        break Err("the Mac showed a different code: someone is in the middle; pairing stopped".into());
                    }
                    if let Some(f) = on_code.take() {
                        f(&code);
                    }
                }
                Ok(Some(Frame::Paired { mac })) => break Ok(mac),
                Ok(Some(Frame::Error { error })) => break Err(error),
                Ok(Some(_)) => break Err("unexpected reply".into()),
                Ok(None) | Err(_) => break Err(close_reason(&conn).unwrap_or_else(|| "the Mac closed the pairing".into())),
            }
        };
        conn.close(0u32.into(), b"done");
        out
    }

    /// Opens the pinned link and says hello with `cursor` ("" for everything).
    pub async fn link(&self, mac: EndpointAddr, cursor: &str) -> Result<Link, String> {
        let conn = self.ep.connect(mac, proto::ALPN_LINK).await.map_err(|e| e.to_string())?;
        let (mut send, recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        write_frame(&mut send, &Frame::Hello { v: proto::VERSION, cursor: cursor.into() }).await?;
        let (tx, mut frames) = mpsc::channel(64);
        tokio::spawn(async move {
            let mut recv = BufReader::new(recv);
            while let Ok(Some(f)) = read_frame(&mut recv).await {
                if tx.send(f).await.is_err() {
                    break;
                }
            }
        });
        let first = tokio::time::timeout(Duration::from_secs(20), frames.recv()).await.map_err(|_| "the Mac didn't answer".to_string())?;
        match first {
            Some(Frame::Welcome { mac, known, .. }) => Ok(Link { conn, send, frames, mac, known, cursor: cursor.into(), next_id: 0 }),
            Some(Frame::Error { error }) => Err(error),
            _ => Err(close_reason(&conn).unwrap_or_else(|| "refused by the Mac (not paired?)".into())),
        }
    }
}

fn close_reason(conn: &Connection) -> Option<String> {
    conn.close_reason().map(|r| r.to_string())
}

pub struct Link {
    conn: Connection,
    send: SendStream,
    frames: mpsc::Receiver<Frame>,
    pub mac: String,
    pub known: Known,
    /// The newest event id received: hand it to the next `link` to resume without gaps.
    pub cursor: String,
    next_id: u64,
}

impl Link {
    /// The next frame from the Mac (Err once the link is closed). Event frames advance `cursor`.
    pub async fn next(&mut self) -> Result<Frame, String> {
        let f = self.frames.recv().await.ok_or_else(|| close_reason(&self.conn).unwrap_or_else(|| "link closed".into()))?;
        match &f {
            Frame::Events { events } => {
                if let Some(id) = events.last().and_then(|v| v["id"].as_str().map(str::to_owned)) {
                    self.cursor = id;
                }
            }
            Frame::Live { cursor } if !cursor.is_empty() => self.cursor = cursor.clone(),
            _ => {}
        }
        Ok(f)
    }

    /// Ids of the next batch of events.
    #[cfg(test)]
    pub async fn next_ids(&mut self) -> Result<Vec<String>, String> {
        loop {
            if let Frame::Events { events } = self.next().await? {
                return Ok(ids(&events));
            }
        }
    }

    /// Everything up to the `live` marker (the backlog), as ids.
    #[cfg(test)]
    pub async fn until_live(&mut self) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        loop {
            match self.next().await? {
                Frame::Events { events } => out.extend(ids(&events)),
                Frame::Live { .. } => return Ok(out),
                _ => {}
            }
        }
    }

    /// Sends a command and waits for its ack (events that arrive meanwhile are skipped; a UI
    /// would keep them). Outer Err: the link failed. Inner: the Mac refused or the command failed.
    pub async fn command(&mut self, command: Command) -> Result<Result<Value, String>, String> {
        self.next_id += 1;
        let id = self.next_id.to_string();
        write_frame(&mut self.send, &Frame::Command { id: id.clone(), command }).await?;
        loop {
            match self.next().await? {
                Frame::Ack { id: got, ok, result, error } if got == id => {
                    return Ok(if ok { Ok(result.unwrap_or(Value::Null)) } else { Err(error.unwrap_or_default()) });
                }
                Frame::Error { error } => return Ok(Err(error)),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
fn ids(events: &[Value]) -> Vec<String> {
    events.iter().filter_map(|v| v["id"].as_str().map(str::to_owned)).collect()
}

// ---------------------------------------------------------------------------------------------
// `Cockpit --remote-peer <state.json> <pair QR|watch [secs]|known|send S TEXT|start W R PROMPT>`

#[derive(Default, Serialize, Deserialize)]
struct PeerState {
    secret: String,
    mac: Option<EndpointAddr>,
    cursor: String,
}

fn load(path: &str) -> PeerState {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(path: &str, s: &PeerState) -> Result<(), String> {
    std::fs::write(path, serde_json::to_vec_pretty(s).unwrap_or_default()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn out(v: Value) {
    println!("{v}");
}

async fn cli(args: Vec<String>) -> Result<(), String> {
    let path = args.first().ok_or("usage: --remote-peer <state.json> <command> …")?.clone();
    let mut st = load(&path);
    let key = match data_encoding::HEXLOWER.decode(st.secret.as_bytes()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) {
        Some(b) => SecretKey::from_bytes(&b),
        None => {
            let k = SecretKey::generate();
            st.secret = data_encoding::HEXLOWER.encode(&k.to_bytes());
            save(&path, &st)?;
            k
        }
    };
    let local = std::env::var("MR_REMOTE_LOCAL").is_ok();
    let peer = Peer::bind(key, local).await?;
    let rest: Vec<&str> = args.iter().skip(1).map(String::as_str).collect();
    if let ["pair", text, ..] = rest.as_slice() {
        let offer = Offer::from_text(text)?;
        let mac = peer
            .pair(&offer, "remote-peer", |code| out(serde_json::json!({ "t": "code", "code": code, "hint": "confirm the same code on the Mac" })))
            .await?;
        st.mac = Some(offer.mac);
        st.cursor.clear();
        save(&path, &st)?;
        out(serde_json::json!({ "t": "paired", "mac": mac }));
        return Ok(());
    }
    let mac = st.mac.clone().ok_or("not paired: run `pair <QR text>` first")?;
    let mut link = peer.link(mac, &st.cursor).await?;
    let result = match rest.as_slice() {
        ["known"] => {
            out(serde_json::json!({ "t": "known", "mac": link.mac, "known": link.known }));
            Ok(())
        }
        ["watch", more @ ..] => {
            let secs: u64 = more.first().and_then(|s| s.parse().ok()).unwrap_or(0);
            let deadline = (secs > 0).then(|| tokio::time::Instant::now() + Duration::from_secs(secs));
            loop {
                let f = match deadline {
                    Some(d) => match tokio::time::timeout_at(d, link.next()).await {
                        Ok(f) => f?,
                        Err(_) => break Ok(()),
                    },
                    None => link.next().await?,
                };
                out(serde_json::to_value(&f).unwrap_or_default());
            }
        }
        ["send", session, text] => link.command(Command::SendPrompt { session: (*session).into(), text: (*text).into() }).await?.map(|v| out(serde_json::json!({ "t": "ok", "result": v }))),
        ["start", ws, repo, prompt] => link
            .command(Command::StartSession { workspace_id: (*ws).into(), repo_id: (*repo).into(), prompt: (*prompt).into() })
            .await?
            .map(|v| out(serde_json::json!({ "t": "ok", "result": v }))),
        ["stop", session] => link.command(Command::StopSession { session: (*session).into() }).await?.map(|v| out(serde_json::json!({ "t": "ok", "result": v }))),
        _ => Err("commands: pair <QR> | known | watch [secs] | send <session> <text> | start <workspace_id> <repo_id> <prompt> | stop <session>".into()),
    };
    st.cursor = link.cursor.clone();
    save(&path, &st)?;
    result
}

/// Entry for `Cockpit --remote-peer …`; returns the exit code.
pub fn main(args: &[String]) -> i32 {
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    match rt.block_on(cli(args.iter().skip(2).cloned().collect())) {
        Ok(()) => 0,
        Err(e) => {
            out(serde_json::json!({ "t": "error", "error": e }));
            1
        }
    }
}
