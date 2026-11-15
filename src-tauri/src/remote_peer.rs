//! `Cockpit --remote-peer <state.json> <pair QR|known|watch [secs]|send S TEXT|start W R PROMPT|stop S>`:
//! the phone side of Cockpit Remote (`remote_link::Peer`) from a terminal, for the self-test and
//! for trying the link without the iOS app.

use std::time::Duration;

use iroh::{EndpointAddr, SecretKey};
use remote_link::proto::{Command, Offer};
use remote_link::Peer;
use serde::{Deserialize, Serialize};
use serde_json::Value;


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
            .command(Command::StartSession { workspace_id: (*ws).into(), repo_id: (*repo).into(), prompt: (*prompt).into(), kind: None })
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
