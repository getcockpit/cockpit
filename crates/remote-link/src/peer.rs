//! Cockpit Remote, phone side: pair with a Mac from its QR text, then open the pinned link,
//! catch up after a cursor, follow live rows and send allowlisted commands. The iOS app
//! (`mobile/`) and `Cockpit --remote-peer` (a terminal, the self-test) both drive this.

use std::time::Duration;

use iroh::endpoint::{Connection, SendStream};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::mpsc;

use crate::proto::{self, read_frame, write_frame, Command, Frame, Known, Offer};

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
        self.link_with(mac, cursor, false).await
    }

    /// `light`: ask for "now" instead of the history (see `Frame::Hello`), for phones without a cache.
    pub async fn link_with(&self, mac: EndpointAddr, cursor: &str, light: bool) -> Result<Link, String> {
        let conn = self.ep.connect(mac, proto::ALPN_LINK).await.map_err(|e| e.to_string())?;
        let (mut send, recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        write_frame(&mut send, &Frame::Hello { v: proto::VERSION, cursor: cursor.into(), light }).await?;
        let (tx, mut frames) = mpsc::channel(64);
        n0_future::task::spawn(async move {
            let mut recv = BufReader::new(recv);
            while let Ok(Some(f)) = read_frame(&mut recv).await {
                if tx.send(f).await.is_err() {
                    break;
                }
            }
        });
        let first = n0_future::time::timeout(Duration::from_secs(20), frames.recv()).await.map_err(|_| "the Mac didn't answer".to_string())?;
        match first {
            Some(Frame::Welcome { mac, known, push_key, .. }) => Ok(Link { conn, send, frames, mac, known, push_key, cursor: cursor.into(), next_id: 0 }),
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
    /// The Mac's VAPID public key (base64url), when it sends Web Push.
    pub push_key: Option<String>,
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
    pub async fn next_ids(&mut self) -> Result<Vec<String>, String> {
        loop {
            if let Frame::Events { events } = self.next().await? {
                return Ok(ids(&events));
            }
        }
    }

    /// Everything up to the `live` marker (the backlog), as ids.
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

    /// Sends a command without waiting: its `Ack` comes back through `next` with the returned id.
    /// For callers that keep reading the link themselves (the iOS app's link task).
    pub async fn send_command(&mut self, command: Command) -> Result<String, String> {
        self.next_id += 1;
        let id = self.next_id.to_string();
        write_frame(&mut self.send, &Frame::Command { id: id.clone(), command }).await?;
        Ok(id)
    }

    /// Asks for one event in full (the Mac streamed it as `remote.truncated`).
    pub async fn fetch(&mut self, id: &str) -> Result<(), String> {
        write_frame(&mut self.send, &Frame::Fetch { id: id.into() }).await
    }

    /// Closes the link (the Mac sees the phone go).
    pub fn close(&self) {
        self.conn.close(0u32.into(), b"bye");
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

fn ids(events: &[Value]) -> Vec<String> {
    events.iter().filter_map(|v| v["id"].as_str().map(str::to_owned)).collect()
}

