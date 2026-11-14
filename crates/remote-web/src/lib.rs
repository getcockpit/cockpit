//! Cockpit Remote in the browser (decision 46): the same `remote-link` peer, compiled to
//! WebAssembly for the installable web app. Browsers can't hole-punch, so iroh always goes through
//! a relay here; the link is still end-to-end encrypted to the pinned Mac.
//!
//! JS sees three things: `WebPeer` (this phone's key; pair), `WebLink` (one live link: frames come
//! to a callback, commands go out) and `version()`.

use iroh::{EndpointAddr, SecretKey};
use remote_link::proto::{Command, Frame, Offer};
use remote_link::Peer;
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

/// iroh writes relay hosts fully qualified (`euc1-1.relay.n0.iroh.link.`). Chrome connects to that,
/// WebKit (every iPhone browser) times out on it, so the browser dials the same host without the
/// final dot.
fn for_webkit(addr: EndpointAddr) -> EndpointAddr {
    let mut v = serde_json::to_value(&addr).unwrap_or_default();
    if let Some(list) = v["addrs"].as_array_mut() {
        for a in list {
            if let Some(url) = a["Relay"].as_str() {
                a["Relay"] = strip_root_dot(url).into();
            }
        }
    }
    serde_json::from_value(v).unwrap_or(addr)
}

fn strip_root_dot(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_owned() };
    let (host, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, String::new()));
    let host = match host.rsplit_once(':') {
        Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => format!("{}:{port}", h.trim_end_matches('.')),
        _ => host.trim_end_matches('.').to_owned(),
    };
    format!("{scheme}://{host}{path}")
}

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn version() -> u32 {
    remote_link::proto::VERSION
}

/// This phone: its link key (hex, kept by the page) and the iroh endpoint bound to it.
#[wasm_bindgen]
pub struct WebPeer {
    peer: std::rc::Rc<Peer>,
    secret: String,
}

#[wasm_bindgen]
impl WebPeer {
    /// Binds with `secret_hex`, or a fresh key when it's empty.
    pub async fn create(secret_hex: String) -> Result<WebPeer, JsValue> {
        let key = match data_encoding::HEXLOWER.decode(secret_hex.as_bytes()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) {
            Some(b) => SecretKey::from_bytes(&b),
            None => SecretKey::generate(),
        };
        let secret = data_encoding::HEXLOWER.encode(&key.to_bytes());
        let peer = Peer::bind(key, false).await.map_err(js_err)?;
        Ok(WebPeer { peer: std::rc::Rc::new(peer), secret })
    }

    /// The key to keep (so the pairing survives a reload).
    pub fn secret(&self) -> String {
        self.secret.clone()
    }

    /// Pairs from the Mac's pairing text. `on_code(code)` gets the 6-digit code; resolves with
    /// `{mac, addr}` (the Mac's name and address JSON to keep).
    /// `passkey_json`: `{credential_id, public_key}` (base64url) of this phone's Face ID passkey,
    /// bound into the pairing; empty for none.
    pub async fn pair(&self, text: String, name: String, passkey_json: String, on_code: js_sys::Function) -> Result<JsValue, JsValue> {
        let passkey = if passkey_json.is_empty() { None } else { Some(serde_json::from_str(&passkey_json).map_err(js_err)?) };
        let mut offer = Offer::from_text(&text).map_err(js_err)?;
        offer.mac = for_webkit(offer.mac);
        let mac = self
            .peer
            .pair_with_passkey(&offer, &name, passkey, |code| {
                let _ = on_code.call1(&JsValue::NULL, &JsValue::from_str(code));
            })
            .await
            .map_err(js_err)?;
        let out = serde_json::json!({ "mac": mac, "addr": offer.mac });
        Ok(JsValue::from_str(&out.to_string()))
    }

    /// Opens the pinned link to `addr_json` after `cursor`. Every frame from the Mac goes to
    /// `on_frame(json)`; when the link ends, `on_frame` gets `{"t":"closed","error":…}`.
    pub async fn link(&self, addr_json: String, cursor: String, on_frame: js_sys::Function) -> Result<WebLink, JsValue> {
        let addr: EndpointAddr = for_webkit(serde_json::from_str(&addr_json).map_err(js_err)?);
        // The web app keeps no history and goes through a relay: it asks for "now", not the log.
        let mut link = self.peer.link_with(addr, &cursor, true).await.map_err(js_err)?;
        let welcome = serde_json::json!({ "t": "welcome", "mac": link.mac, "known": link.known, "push_key": link.push_key, "nonce": link.nonce, "app": link.app });
        let _ = on_frame.call1(&JsValue::NULL, &JsValue::from_str(&welcome.to_string()));
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        n0_future::task::spawn(async move {
            let why = loop {
                tokio::select! {
                    f = link.next() => match f {
                        Ok(f) => { let _ = on_frame.call1(&JsValue::NULL, &JsValue::from_str(&serde_json::to_string(&f).unwrap_or_default())); }
                        Err(e) => break e,
                    },
                    c = rx.recv() => match c {
                        Some(Out::Command(c, p)) => if let Err(e) = link.send_command_proved(c, p).await { break e },
                        Some(Out::Frame(f)) => if let Err(e) = link.send(&f).await { break e },
                        None => { link.close(); break "closed".into() }
                    },
                }
            };
            let _ = on_frame.call1(&JsValue::NULL, &JsValue::from_str(&serde_json::json!({ "t": "closed", "error": why }).to_string()));
        });
        Ok(WebLink { tx: Some(tx) })
    }
}

enum Out {
    Command(Command, Option<remote_link::proto::Proof>),
    Frame(Frame),
}

/// One live link. Commands go out in order; their acks come back as `{"t":"ack","id":…}` frames
/// (ids count from 1 per link).
#[wasm_bindgen]
pub struct WebLink {
    tx: Option<mpsc::UnboundedSender<Out>>,
}

#[wasm_bindgen]
impl WebLink {
    /// Sends one allowlisted command (`{kind, args}` JSON), with `proof_json` (a `proto::Proof`
    /// whose `json` is exactly this command) when it needs Face ID; empty for none.
    pub fn command(&self, json: String, proof_json: String) -> Result<(), JsValue> {
        let c: Command = serde_json::from_str(&json).map_err(|e| js_err(format!("not a Cockpit Remote command: {e}")))?;
        c.check().map_err(js_err)?;
        let proof = if proof_json.is_empty() { None } else { Some(serde_json::from_str(&proof_json).map_err(js_err)?) };
        self.out(Out::Command(c, proof))
    }

    /// Asks for one session's recent rows; they come back as `{"t":"session_rows","id":…}`.
    pub fn fetch_session(&self, id: String, session: String) -> Result<(), JsValue> {
        self.out(Out::Frame(Frame::FetchSession { id, session }))
    }

    fn out(&self, o: Out) -> Result<(), JsValue> {
        self.tx.as_ref().ok_or("link closed")?.send(o).map_err(|_| js_err("link closed"))
    }

    pub fn close(&mut self) {
        self.tx = None;
    }
}

#[cfg(test)]
mod tests {
    use super::strip_root_dot;

    #[test]
    fn relay_hosts_lose_only_the_root_dot() {
        assert_eq!(strip_root_dot("https://euc1-1.relay.n0.iroh.link./"), "https://euc1-1.relay.n0.iroh.link/");
        assert_eq!(strip_root_dot("https://relay.example.com.:8443/x"), "https://relay.example.com:8443/x");
        assert_eq!(strip_root_dot("https://relay.example.com/"), "https://relay.example.com/");
        assert_eq!(strip_root_dot("not a url"), "not a url");
    }
}
