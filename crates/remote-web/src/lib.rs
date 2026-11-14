//! Cockpit Remote in the browser (decision 46): the same `remote-link` peer, compiled to
//! WebAssembly for the installable web app. Browsers can't hole-punch, so iroh always goes through
//! a relay here; the link is still end-to-end encrypted to the pinned Mac.
//!
//! JS sees three things: `WebPeer` (this phone's key; pair), `WebLink` (one live link: frames come
//! to a callback, commands go out) and `version()`.

use iroh::{EndpointAddr, SecretKey};
use remote_link::proto::{Command, Offer};
use remote_link::Peer;
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

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
    pub async fn pair(&self, text: String, name: String, on_code: js_sys::Function) -> Result<JsValue, JsValue> {
        let offer = Offer::from_text(&text).map_err(js_err)?;
        let mac = self
            .peer
            .pair(&offer, &name, |code| {
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
        let addr: EndpointAddr = serde_json::from_str(&addr_json).map_err(js_err)?;
        let mut link = self.peer.link(addr, &cursor).await.map_err(js_err)?;
        let welcome = serde_json::json!({ "t": "welcome", "mac": link.mac, "known": link.known });
        let _ = on_frame.call1(&JsValue::NULL, &JsValue::from_str(&welcome.to_string()));
        let (tx, mut rx) = mpsc::unbounded_channel::<Command>();
        n0_future::task::spawn(async move {
            let why = loop {
                tokio::select! {
                    f = link.next() => match f {
                        Ok(f) => { let _ = on_frame.call1(&JsValue::NULL, &JsValue::from_str(&serde_json::to_string(&f).unwrap_or_default())); }
                        Err(e) => break e,
                    },
                    c = rx.recv() => match c {
                        Some(c) => if let Err(e) = link.send_command(c).await { break e },
                        None => { link.close(); break "closed".into() }
                    },
                }
            };
            let _ = on_frame.call1(&JsValue::NULL, &JsValue::from_str(&serde_json::json!({ "t": "closed", "error": why }).to_string()));
        });
        Ok(WebLink { tx: Some(tx) })
    }
}

/// One live link. Commands go out in order; their acks come back as `{"t":"ack","id":…}` frames
/// (ids count from 1 per link).
#[wasm_bindgen]
pub struct WebLink {
    tx: Option<mpsc::UnboundedSender<Command>>,
}

#[wasm_bindgen]
impl WebLink {
    /// Sends one allowlisted command (`{kind, args}` JSON).
    pub fn command(&self, json: String) -> Result<(), JsValue> {
        let c: Command = serde_json::from_str(&json).map_err(|e| js_err(format!("not a Cockpit Remote command: {e}")))?;
        c.check().map_err(js_err)?;
        self.tx.as_ref().ok_or("link closed")?.send(c).map_err(|_| js_err("link closed"))
    }

    pub fn close(&mut self) {
        self.tx = None;
    }
}
