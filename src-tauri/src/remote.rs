//! Cockpit Remote, Mac side (doc "Cockpit Remote: phone ↔ laptop, no server"): one paired phone
//! reaches this Mac over iroh (QUIC dialed by public key, hole punching, an end-to-end encrypted
//! relay when that fails). No server of ours, nothing listening publicly.
//!
//! - **Pairing** (`ALPN_PAIR`): Settings → Remote shows a QR (Mac key + addresses + a one-time
//!   secret, 2 min). The phone proves it saw it (`pair_proof`), both screens show the same 6-digit
//!   code, you confirm here, and the Mac pins exactly one phone key.
//! - **Link** (`ALPN_LINK`): only the pinned key gets past the first check. The phone says
//!   `hello {cursor}`, gets the log after it (ULID order, gap-free) and then live rows, and sends
//!   allowlisted commands that run through the same handlers as the desktop, logged with
//!   `origin: "remote"` in the `ui.*` payload.
//! - **Unpair** closes the live link at once and rotates the Mac's key, so old QR data is useless.
//!
//! The protocol core (`Shared`) talks to the app through `Host`, so tests drive it with a fake.

use std::cell::Cell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::{Connection, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::{mpsc, oneshot, watch};

use remote_link::proto::{self, read_frame, write_frame, Command, Frame, Known, Offer, StartLimit};

// ---------------------------------------------------------------------------------------------
// origin: "remote" on every ui.* row a phone command writes

thread_local! {
    static ACTING: Cell<bool> = const { Cell::new(false) };
}

/// Runs `f` as the phone: `eventlog::record` tags every `ui.*` row it writes with `origin: "remote"`.
pub fn as_phone<T>(f: impl FnOnce() -> T) -> T {
    ACTING.with(|a| a.set(true));
    let out = f();
    ACTING.with(|a| a.set(false));
    out
}

/// The payload to store: tagged when a phone command is writing it.
pub fn tag(kind: &str, payload: &Value) -> Option<Value> {
    if !kind.starts_with("ui.") || !ACTING.with(|a| a.get()) {
        return None;
    }
    let mut p = if payload.is_object() { payload.clone() } else { serde_json::json!({ "value": payload }) };
    p["origin"] = "remote".into();
    Some(p)
}

// ---------------------------------------------------------------------------------------------
// The app behind the protocol

/// One stored event as the phone gets it.
#[derive(Debug, Clone)]
pub struct Stored {
    pub id: String,
    pub kind: String,
    pub session_id: Option<String>,
    pub created_at: i64,
    pub json: String,
}

/// A command after the Mac resolved ids to its own state.
#[derive(Debug, Clone, PartialEq)]
pub enum Resolved {
    Send { session: String, text: String },
    Respond { session: String, request_id: String, decision: Value },
    Interrupt { session: String },
    Stop { session: String },
    Start { cwd: String, workspace: String, prompt: String, kind: String },
    RegisterPush { subscription: Value },
    LogUi { session: Option<String>, kind: String, payload: Value, anchor: Option<String> },
    DocSend { doc_id: String, regenerate: bool },
}

pub trait Host: Send + Sync + 'static {
    /// Rows after `after` (exclusive), ULID order, at most `limit`.
    fn events_after(&self, after: &str, limit: usize) -> Vec<Stored>;
    /// The light first sync (`Frame::Hello { light }`): "now" up to the log's newest row, and that
    /// row's id as the cursor to follow from.
    fn now_rows(&self) -> (Vec<Stored>, String);
    fn event(&self, id: &str) -> Option<Stored>;
    /// One session's last `limit` rows, oldest first.
    fn session_rows(&self, session: &str, limit: usize) -> Vec<Stored>;
    /// Working docs touched lately (folded on the Mac), as the desktop's `docs_list` gives them.
    fn docs(&self) -> Vec<Value> {
        Vec::new()
    }
    fn known(&self) -> Known;
    fn session_exists(&self, id: &str) -> bool;
    /// Runs a resolved command exactly as the desktop would. Called off the async runtime.
    fn run(&self, cmd: Resolved) -> Result<Value, String>;
    /// Pairing state changed: the Settings panel refreshes.
    fn changed(&self) {}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Phone {
    pub key: String,
    pub name: String,
    pub paired_at: i64,
    /// The web app's Face ID key, bound at pairing (decision 46). With one, what runs Claude
    /// needs its proof; without (native app, CLI), the phone gates it itself.
    #[serde(default)]
    pub passkey: Option<proto::Passkey>,
}

struct Pending {
    phone: Phone,
    code: String,
    answer: Option<oneshot::Sender<bool>>,
}

/// Persists the paired phone (or None).
pub type SavePhone = Box<dyn Fn(Option<&Phone>) + Send + Sync>;

/// The protocol core: pairing, the pinned phone, the stream and the command allowlist.
pub struct Shared {
    host: Box<dyn Host>,
    mac_key: [u8; 32],
    name: String,
    phone: Mutex<Option<Phone>>,
    offer: Mutex<Option<Offer>>,
    pending: Mutex<Option<Pending>>,
    /// Bumped on every new row; links re-read the log after their cursor (gap-free by design).
    tick: watch::Sender<u64>,
    conns: Mutex<Vec<Connection>>,
    starts: Mutex<StartLimit>,
    last_seen: AtomicI64,
    /// This Mac's VAPID public key, sent in the welcome so the phone can subscribe (decision 46).
    push_key: Mutex<Option<String>>,
    /// Origins a passkey proof may come from: the web app's, plus `MR_REMOTE_DEV_ORIGIN` (a local
    /// build of it, for development).
    origins: Vec<String>,
    /// Called with the new phone (or None) whenever pairing changes, to persist it.
    save: SavePhone,
}

impl Shared {
    pub fn new(host: Box<dyn Host>, mac_key: [u8; 32], name: String, phone: Option<Phone>, save: SavePhone) -> Arc<Self> {
        Arc::new(Self {
            host,
            mac_key,
            name,
            phone: Mutex::new(phone),
            offer: Mutex::new(None),
            pending: Mutex::new(None),
            tick: watch::channel(0).0,
            conns: Mutex::new(Vec::new()),
            starts: Mutex::new(StartLimit::default()),
            last_seen: AtomicI64::new(0),
            push_key: Mutex::new(None),
            origins: std::iter::once(proto::ORIGIN.to_string()).chain(std::env::var("MR_REMOTE_DEV_ORIGIN").ok().filter(|o| !o.is_empty())).collect(),
            save,
        })
    }

    pub fn set_push_key(&self, key: Option<String>) {
        *self.push_key.lock().unwrap() = key;
    }

    /// A new row is in the log.
    pub fn bump(&self) {
        self.tick.send_modify(|n| *n += 1);
    }

    pub fn phone(&self) -> Option<Phone> {
        self.phone.lock().unwrap().clone()
    }

    /// A fresh pairing offer for `mac` (replaces any earlier one).
    pub fn offer(&self, mac: iroh::EndpointAddr) -> Offer {
        let o = Offer {
            mac,
            secret: data_encoding::HEXLOWER.encode(&proto::new_secret()),
            expires_at: proto::now_ms() + proto::OFFER_TTL_MS,
            name: self.name.clone(),
        };
        *self.offer.lock().unwrap() = Some(o.clone());
        o
    }

    /// The code waiting for you to confirm on the Mac, and the phone's name.
    pub fn pending(&self) -> Option<(String, String)> {
        self.pending.lock().unwrap().as_ref().map(|p| (p.code.clone(), p.phone.name.clone()))
    }

    /// You confirmed (or rejected) the code on the Mac.
    pub fn answer(&self, accept: bool) -> Result<(), String> {
        let tx = self.pending.lock().unwrap().as_mut().and_then(|p| p.answer.take()).ok_or("no pairing is waiting")?;
        tx.send(accept).map_err(|_| "the phone went away".to_string())
    }

    /// Forgets the phone and cuts any live link right away.
    pub fn unpair(&self) {
        *self.phone.lock().unwrap() = None;
        *self.offer.lock().unwrap() = None;
        (self.save)(None);
        for c in self.conns.lock().unwrap().drain(..) {
            c.close(1u32.into(), b"unpaired");
        }
        self.host.changed();
    }

    pub fn connected(&self) -> bool {
        self.conns.lock().unwrap().iter().any(|c| c.close_reason().is_none())
    }

    pub fn last_seen(&self) -> i64 {
        self.last_seen.load(Ordering::Relaxed)
    }

    /// Validates a command against the allowlist and the Mac's state, mapping ids to paths.
    pub fn resolve(&self, cmd: Command) -> Result<Resolved, String> {
        cmd.check()?;
        if let Some(s) = cmd.session() && !self.host.session_exists(s) {
            return Err(format!("unknown session {s}"));
        }
        Ok(match cmd {
            Command::SendPrompt { session, text } => Resolved::Send { session, text },
            Command::AnswerQuestion { session, request_id, input, answers } => Resolved::Respond { session, request_id, decision: Command::answer_decision(&input, &answers) },
            Command::PermissionResponse { session, request_id, decision } => Resolved::Respond { session, request_id, decision },
            Command::Interrupt { session } => Resolved::Interrupt { session },
            Command::StopSession { session } => Resolved::Stop { session },
            Command::StartSession { workspace_id, repo_id, prompt, kind } => {
                let known = self.host.known();
                let repo = known.repos.iter().find(|r| r.id == repo_id).ok_or("unknown repo: start it once on the Mac first")?;
                if !known.workspaces.iter().any(|w| w.id == workspace_id) {
                    return Err("unknown workspace".into());
                }
                self.starts.lock().unwrap().take(proto::now_ms())?;
                Resolved::Start { cwd: repo.path.clone(), workspace: workspace_id, prompt, kind: kind.unwrap_or_else(|| "blank".into()) }
            }
            Command::RegisterPush { subscription } => Resolved::RegisterPush { subscription },
            Command::LogUi { session, kind, payload, anchor } => Resolved::LogUi { session, kind, payload, anchor },
            Command::DocSend { doc_id, regenerate } => Resolved::DocSend { doc_id, regenerate },
        })
    }

    fn execute(&self, cmd: Command) -> Result<Value, String> {
        let r = self.resolve(cmd)?;
        as_phone(|| self.host.run(r))
    }

    /// Face ID on what runs Claude (decision 46): when the phone paired with a passkey, allow,
    /// answer and start need a proof signed on this link's nonce over exactly this command.
    fn check_presence(&self, command: &Command, proof: Option<&proto::Proof>, nonce: &str, spent: &mut std::collections::HashSet<String>) -> Result<(), String> {
        let Some(key) = self.phone().and_then(|p| p.passkey) else { return Ok(()) };
        if !command.needs_presence() {
            return Ok(());
        }
        let proof = proof.ok_or("this needs Face ID on your phone")?;
        let signed = proto::verify_proof(&key, proof, nonce, &self.origins, proto::RP_ID)?;
        if &signed != command {
            return Err("the Face ID proof is for a different command".into());
        }
        if !spent.insert(proto::challenge(nonce, &proof.json)) {
            return Err("this Face ID proof was already used".into());
        }
        Ok(())
    }

    fn is_pinned(&self, key: &PublicKey) -> bool {
        self.phone.lock().unwrap().as_ref().is_some_and(|p| p.key == key.to_string())
    }
}

// ---------------------------------------------------------------------------------------------
// Frames over a QUIC stream

fn accept_err(e: impl std::fmt::Display) -> AcceptError {
    AcceptError::from_err(std::io::Error::other(e.to_string()))
}

// ---------------------------------------------------------------------------------------------
// Pairing

#[derive(Clone)]
pub struct Pairing(pub Arc<Shared>);

impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pairing")
    }
}

impl ProtocolHandler for Pairing {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let shared = &self.0;
        // Single use: whatever happens next, this QR is spent.
        let offer = shared.offer.lock().unwrap().take();
        let Some(offer) = offer.filter(|o| o.expires_at > proto::now_ms()) else {
            conn.close(2u32.into(), b"no pairing offer");
            return Ok(());
        };
        let (mut send, recv) = conn.accept_bi().await?;
        let mut recv = BufReader::new(recv);
        let phone_key = *conn.remote_id().as_bytes();
        let secret = offer.secret_bytes().map_err(accept_err)?;
        let Ok(Some(Frame::Pair { proof, name, passkey })) = tokio::time::timeout(Duration::from_secs(30), read_frame(&mut recv)).await.unwrap_or(Ok(None)) else {
            conn.close(2u32.into(), b"expected pair");
            return Ok(());
        };
        if !proto::proof_ok(&secret, &shared.mac_key, &phone_key, &proof) {
            let _ = write_frame(&mut send, &Frame::Error { error: "this phone didn't scan the code shown on the Mac".into() }).await;
            let _ = send.finish();
            let _ = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await;
            return Ok(());
        }
        let code = proto::short_code(&secret, &shared.mac_key, &phone_key);
        let (tx, rx) = oneshot::channel();
        let name: String = name.chars().take(60).collect();
        let phone = Phone { key: conn.remote_id().to_string(), name, paired_at: proto::now_ms(), passkey };
        *shared.pending.lock().unwrap() = Some(Pending { phone: phone.clone(), code: code.clone(), answer: Some(tx) });
        shared.host.changed();
        write_frame(&mut send, &Frame::Confirm { code }).await.map_err(accept_err)?;
        let accepted = matches!(tokio::time::timeout(Duration::from_millis(proto::OFFER_TTL_MS as u64), rx).await, Ok(Ok(true)));
        *shared.pending.lock().unwrap() = None;
        let reply = if accepted {
            *shared.phone.lock().unwrap() = Some(phone.clone());
            (shared.save)(Some(&phone));
            // A previously paired phone loses its link now.
            for c in shared.conns.lock().unwrap().drain(..) {
                c.close(1u32.into(), b"replaced");
            }
            Frame::Paired { mac: shared.name.clone() }
        } else {
            Frame::Error { error: "pairing was declined on the Mac".into() }
        };
        shared.host.changed();
        let _ = write_frame(&mut send, &reply).await;
        let _ = send.finish();
        let _ = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// The live link

#[derive(Clone)]
pub struct Link(pub Arc<Shared>);

impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Link")
    }
}

/// Bytes per backlog frame; one event is at most `MAX_EVENT_BYTES`, so a frame stays under `MAX_LINE`.
const BATCH_BYTES: usize = 512 * 1024;

impl Link {
    /// Sends every row after `cursor` and returns the new cursor. Reads happen off the runtime.
    /// Sends every row after `cursor` and returns the new cursor. Reads happen off the runtime.
    /// `light`: only what `keep_light` keeps, slimmed; it tracks which sessions are live.
    async fn catch_up(&self, send: &mut SendStream, mut cursor: String, mut light: Option<&mut Light>) -> Result<String, String> {
        loop {
            let shared = self.0.clone();
            let after = cursor.clone();
            let rows = tokio::task::spawn_blocking(move || shared.host.events_after(&after, 500)).await.map_err(|e| e.to_string())?;
            let Some(last) = rows.last() else { return Ok(cursor) };
            cursor = last.id.clone();
            let full = rows.len() == 500;
            let rows: Vec<Stored> = match light.as_deref_mut() {
                Some(l) => rows.into_iter().filter(|r| l.keep(r)).map(slim).collect(),
                None => rows,
            };
            self.send_rows(send, rows).await?;
            if !full {
                return Ok(cursor);
            }
        }
    }

    async fn send_rows(&self, send: &mut SendStream, rows: Vec<Stored>) -> Result<(), String> {
        {
            let mut batch: Vec<Value> = Vec::new();
            let mut size = 0;
            for r in rows {
                let Some(j) = proto::for_phone(&r.id, &r.kind, r.session_id.as_deref(), r.created_at, &r.json) else { continue };
                if size + j.len() > BATCH_BYTES && !batch.is_empty() {
                    write_frame(send, &Frame::Events { events: std::mem::take(&mut batch) }).await?;
                    size = 0;
                }
                size += j.len();
                if let Ok(v) = serde_json::from_str(&j) {
                    batch.push(v);
                }
            }
            if !batch.is_empty() {
                write_frame(send, &Frame::Events { events: batch }).await?;
            }
        }
        Ok(())
    }

    async fn serve(&self, conn: Connection) -> Result<(), String> {
        let shared = self.0.clone();
        let (mut send, recv) = conn.accept_bi().await.map_err(|e| e.to_string())?;
        // Frames come in on their own task: a read cancelled by select! would lose half a line.
        let (tx, mut frames) = mpsc::channel::<Result<Frame, String>>(16);
        tokio::spawn(async move {
            let mut recv = BufReader::new(recv);
            loop {
                match read_frame(&mut recv).await {
                    Ok(Some(f)) => {
                        if tx.send(Ok(f)).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        break;
                    }
                }
            }
        });
        let (cursor, light) = match tokio::time::timeout(Duration::from_secs(30), frames.recv()).await {
            Ok(Some(Ok(Frame::Hello { v, cursor, light }))) if v == proto::VERSION => (cursor, light),
            Ok(Some(Ok(Frame::Hello { v, .. }))) => {
                write_frame(&mut send, &Frame::Error { error: format!("protocol v{v} not supported; this Mac speaks v{}", proto::VERSION) }).await?;
                return Ok(());
            }
            _ => return Err("expected hello".into()),
        };
        // Subscribe before reading the backlog, so a row written in between still wakes us.
        let mut tick = shared.tick.subscribe();
        let s2 = shared.clone();
        let known = tokio::task::spawn_blocking(move || s2.host.known()).await.map_err(|e| e.to_string())?;
        let push_key = shared.push_key.lock().unwrap().clone();
        // Passkey proofs sign this link's nonce, so none can be replayed on another link; `spent`
        // stops a replay on this one.
        let nonce = data_encoding::HEXLOWER.encode(&proto::new_secret());
        let mut spent = std::collections::HashSet::new();
        write_frame(&mut send, &Frame::Welcome { v: proto::VERSION, mac: shared.name.clone(), known, push_key, nonce: Some(nonce.clone()), app: web_app() }).await?;
        // Light: "now" in one query, then the same rules row by row (a busy log appends many rows
        // a second; re-running the query for each would cost the Mac ~0.7 s a time).
        let mut light = if light {
            let s2 = shared.clone();
            let (rows, upto) = tokio::task::spawn_blocking(move || s2.host.now_rows()).await.map_err(|e| e.to_string())?;
            let state = Light::from_rows(&rows);
            // A reconnect already has what came before its cursor.
            self.send_rows(&mut send, rows.into_iter().filter(|r| r.id > cursor).map(slim).collect()).await?;
            Some((state, upto))
        } else {
            None
        };
        let cursor = match &light { Some((_, upto)) if upto.as_str() > cursor.as_str() => upto.clone(), _ => cursor };
        let mut light = light.take().map(|(s, _)| s);
        let mut cursor = self.catch_up(&mut send, cursor, light.as_mut()).await?;
        write_frame(&mut send, &Frame::Live { cursor: cursor.clone() }).await?;
        loop {
            tokio::select! {
                changed = tick.changed() => {
                    if changed.is_err() { return Ok(()) }
                    cursor = self.catch_up(&mut send, cursor, light.as_mut()).await?;
                }
                frame = frames.recv() => {
                    shared.last_seen.store(proto::now_ms(), Ordering::Relaxed);
                    let reply = match frame {
                        None => return Ok(()),
                        Some(Err(e)) => Frame::Error { error: e },
                        Some(Ok(Frame::Command { id, command, proof })) => {
                            let s = shared.clone();
                            let out = match shared.check_presence(&command, proof.as_ref(), &nonce, &mut spent) {
                                Err(e) => Err(e),
                                Ok(()) => tokio::task::spawn_blocking(move || s.execute(command)).await.map_err(|e| e.to_string())?,
                            };
                            match out {
                                Ok(result) => Frame::Ack { id, ok: true, result: Some(result), error: None },
                                Err(e) => Frame::Ack { id, ok: false, result: None, error: Some(e) },
                            }
                        }
                        Some(Ok(Frame::FetchDocs { id })) => {
                            let s = shared.clone();
                            let docs = tokio::task::spawn_blocking(move || s.host.docs()).await.map_err(|e| e.to_string())?;
                            Frame::Docs { id, docs }
                        }
                        Some(Ok(Frame::FetchSession { id, session })) => {
                            let s = shared.clone();
                            let sid = session.clone();
                            let rows = tokio::task::spawn_blocking(move || s.host.session_rows(&sid, proto::SESSION_ROWS)).await.map_err(|e| e.to_string())?;
                            let events = rows
                                .into_iter()
                                .filter_map(|r| proto::for_phone(&r.id, &r.kind, r.session_id.as_deref(), r.created_at, &r.json))
                                .filter_map(|j| serde_json::from_str(&j).ok())
                                .collect();
                            Frame::SessionRows { id, session, events }
                        }
                        Some(Ok(Frame::Fetch { id })) => {
                            let s = shared.clone();
                            let ev = tokio::task::spawn_blocking(move || s.host.event(&id)).await.map_err(|e| e.to_string())?;
                            match ev.filter(|e| !proto::SKIP_KINDS.contains(&e.kind.as_str())).and_then(|e| serde_json::from_str(&e.json).ok()) {
                                Some(raw) => Frame::Event { event: raw },
                                None => Frame::Error { error: "no such event".into() },
                            }
                        }
                        Some(Ok(_)) => Frame::Error { error: "unexpected frame".into() },
                    };
                    write_frame(&mut send, &reply).await?;
                }
            }
        }
    }
}

impl ProtocolHandler for Link {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        // The pin check comes before any stream is read: nothing else gets app data.
        if !self.0.is_pinned(&conn.remote_id()) {
            conn.close(3u32.into(), b"not paired");
            return Ok(());
        }
        self.0.last_seen.store(proto::now_ms(), Ordering::Relaxed);
        self.0.conns.lock().unwrap().push(conn.clone());
        self.0.host.changed();
        let out = self.serve(conn.clone()).await;
        self.0.conns.lock().unwrap().retain(|c| c.stable_id() != conn.stable_id());
        self.0.host.changed();
        out.map_err(accept_err)
    }
}

/// Starts the iroh endpoint for `shared`. `local` binds without relays or discovery (tests).
pub async fn listen(shared: Arc<Shared>, key: SecretKey, local: bool) -> Result<Router, String> {
    let ep = if local {
        Endpoint::builder(iroh::endpoint::presets::Minimal).secret_key(key).bind().await
    } else {
        Endpoint::builder(iroh::endpoint::presets::N0).secret_key(key).bind().await
    }
    .map_err(|e| e.to_string())?;
    Ok(Router::builder(ep).accept(proto::ALPN_PAIR, Pairing(shared.clone())).accept(proto::ALPN_LINK, Link(shared)).spawn())
}

// ---------------------------------------------------------------------------------------------
// The app: Tauri state, the real Host, Settings → Remote commands

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Store {
    enabled: bool,
    phone: Option<Phone>,
    /// The paired phone's Web Push subscription (decision 46); dropped on unpair or when it's gone.
    #[serde(default)]
    push: Option<remote_push::Subscription>,
}

const KEYCHAIN_SERVICE: &str = "cockpit-remote";
/// The phone's web app (decision 46): the same static page for every Cockpit owner.
const WEB_APP: &str = "https://getcockpit.github.io/remote/";

/// The web app version this build vouches for (decision 47), from site/remote/current.json at
/// build time; None in a build without it.
fn web_app() -> Option<proto::AppPin> {
    let (version, root, sw) = (env!("MR_REMOTE_APP_VERSION"), env!("MR_REMOTE_APP_ROOT"), env!("MR_REMOTE_APP_SW"));
    (!version.is_empty() && !root.is_empty()).then(|| proto::AppPin { version: version.into(), root: root.into(), sw: Some(sw.to_owned()).filter(|s| !s.is_empty()) })
}
const KEYCHAIN_ACCOUNT: &str = "identity";

/// Tauri state: the store on disk and, while Remote is on, the running endpoint.
pub struct Remote {
    dir: PathBuf,
    running: Mutex<Option<(Arc<Shared>, Router)>>,
}

impl Remote {
    fn store_path(&self) -> PathBuf {
        self.dir.join("remote.json")
    }

    fn load(&self) -> Store {
        std::fs::read(self.store_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn shared(&self) -> Option<Arc<Shared>> {
        self.running.lock().unwrap().as_ref().map(|(s, _)| s.clone())
    }
}

fn save_store(path: &std::path::Path, store: &Store) {
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(store).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// The Mac's long-term identity: the Keychain for the installed app; a 0600 file next to the log
/// when `MR_DATA_DIR` is set (self-tests and dev data dirs never touch the real Keychain).
fn identity(dir: &std::path::Path, rotate: bool) -> Result<SecretKey, String> {
    let scratch = std::env::var("MR_DATA_DIR").is_ok_and(|d| !d.is_empty());
    let file = dir.join("remote.key");
    let existing = if rotate {
        None
    } else if scratch {
        std::fs::read_to_string(&file).ok()
    } else {
        crate::sys::keychain_find(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    };
    if let Some(k) = existing.and_then(|h| data_encoding::HEXLOWER.decode(h.trim().as_bytes()).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok()) {
        return Ok(SecretKey::from_bytes(&k));
    }
    let key = SecretKey::generate();
    let hex = data_encoding::HEXLOWER.encode(&key.to_bytes());
    if scratch {
        std::fs::write(&file, &hex).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
        }
    } else {
        crate::sys::keychain_set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, &hex)?;
    }
    Ok(key)
}

fn mac_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(o) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let n = String::from_utf8_lossy(&o.stdout).trim().to_owned();
        if !n.is_empty() {
            return n;
        }
    }
    std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")).unwrap_or_else(|_| "Mac".into())
}

struct AppHost(tauri::AppHandle);

/// The light stream's rules for rows after the first sync (the same as `EventLog::now_rows`):
/// workspace rows, and for sessions that aren't archived their starts, asks, answers, messages,
/// titles and turn ends. Archiving drops a session; starting or unarchiving adds it.
#[derive(Default)]
pub struct Light {
    live: std::collections::HashSet<String>,
}

impl Light {
    fn from_rows(rows: &[Stored]) -> Self {
        Self { live: rows.iter().filter(|r| r.kind == "ui.session_requested").filter_map(|r| r.session_id.clone()).collect() }
    }

    pub fn keep(&mut self, r: &Stored) -> bool {
        // Doc rows of any session: the phone refetches its docs when one lands.
        if r.kind.starts_with("doc.") || r.kind.starts_with("ui.doc_") {
            return true;
        }
        let Some(s) = r.session_id.as_deref() else { return r.kind.starts_with("ui.workspace_") };
        match r.kind.as_str() {
            "ui.session_requested" | "ui.session_unarchived" => {
                self.live.insert(s.to_owned());
                return true;
            }
            "ui.session_archived" => return self.live.remove(s),
            _ => {}
        }
        self.live.contains(s)
            && (r.kind.starts_with("ui.session_")
                || ["flow.", "plan.", "ui.review_", "ui.address_"].iter().any(|p| r.kind.starts_with(p))
                || matches!(r.kind.as_str(), "sidecar.session_started" | "sidecar.session_ended" | "sidecar.permission_request" | "ui.permission_answered" | "ui.message_sent" | "session.titled")
                || (r.kind == "sidecar.sdk" && r.json.contains("\"type\":\"result\"") && serde_json::from_str::<Value>(&r.json).is_ok_and(|v| v["payload"]["message"]["type"] == "result")))
    }
}

/// Light stream: a turn end keeps what lamps and the phone show (type, error, a short result
/// line, timing) and drops the usage and cost detail, about 3.5 KB a row on a busy log.
fn slim(mut r: Stored) -> Stored {
    if r.kind != "sidecar.sdk" {
        return r;
    }
    let Ok(mut v) = serde_json::from_str::<Value>(&r.json) else { return r };
    let m = &v["payload"]["message"];
    if m["type"] != "result" {
        return r;
    }
    let text: String = m["result"].as_str().unwrap_or_default().chars().take(400).collect();
    let keep = serde_json::json!({ "type": "result", "subtype": m["subtype"], "is_error": m["is_error"], "result": text, "duration_ms": m["duration_ms"], "session_id": m["session_id"] });
    v["payload"]["message"] = keep;
    r.json = v.to_string();
    r
}

fn stored(w: crate::eventlog::WireEvent) -> Option<Stored> {
    Some(Stored { id: w.id.clone(), kind: w.kind.clone(), session_id: w.session_id.clone(), created_at: w.created_at, json: serde_json::to_string(&w).ok()? })
}

impl Host for AppHost {
    fn now_rows(&self) -> (Vec<Stored>, String) {
        use tauri::Manager;
        let log = self.0.state::<crate::eventlog::EventLog>();
        let upto = log.last_id().ok().flatten().unwrap_or_default();
        (log.now_rows(&upto).unwrap_or_default().into_iter().filter_map(stored).collect(), upto)
    }

    fn events_after(&self, after: &str, limit: usize) -> Vec<Stored> {
        use tauri::Manager;
        let log = self.0.state::<crate::eventlog::EventLog>();
        // Like the desktop's first load: archived sessions come without their transcripts.
        log.list_wire(None, Some(after), limit as i64, true).unwrap_or_default().into_iter().filter_map(stored).collect()
    }

    fn docs(&self) -> Vec<Value> {
        use tauri::Manager;
        let since = proto::now_ms() - 30 * 86_400_000;
        self.0.state::<crate::docs::Docs>().list().into_iter().filter(|d| d.updated_at >= since).filter_map(|d| serde_json::to_value(d).ok()).collect()
    }

    fn session_rows(&self, session: &str, limit: usize) -> Vec<Stored> {
        use tauri::Manager;
        let rows: Vec<Stored> = self.0.state::<crate::eventlog::EventLog>().session_wire(session).unwrap_or_default().into_iter().filter(|w| w.session_id.as_deref() == Some(session)).filter_map(stored).collect();
        let skip = rows.len().saturating_sub(limit);
        rows.into_iter().skip(skip).collect()
    }

    fn event(&self, id: &str) -> Option<Stored> {
        use tauri::Manager;
        self.0.state::<crate::eventlog::EventLog>().get_wire(id).ok().flatten().and_then(stored)
    }

    fn known(&self) -> Known {
        use tauri::Manager;
        let evs = self.0.state::<crate::eventlog::EventLog>().list_prefixed(&["ui.workspace_", "ui.session_requested"]).unwrap_or_default();
        proto::known_from(evs.iter().map(|e| (e.kind.as_str(), &e.payload)))
    }

    fn session_exists(&self, id: &str) -> bool {
        use tauri::Manager;
        !self.0.state::<crate::eventlog::EventLog>().list(Some(id), None, 1).unwrap_or_default().is_empty()
    }

    fn run(&self, cmd: Resolved) -> Result<Value, String> {
        use crate::sidecar as sc;
        use tauri::Manager;
        let app = self.0.clone();
        let state = || app.state::<sc::Sidecar>();
        match cmd {
            Resolved::Send { session, text } => sc::session_send(app.clone(), state(), session, text, None).map(|_| Value::Null),
            Resolved::Respond { session, request_id, decision } => sc::permission_respond(app.clone(), state(), session, request_id, decision).map(|_| Value::Null),
            Resolved::Interrupt { session } => sc::session_interrupt(app.clone(), state(), session).map(|_| Value::Null),
            Resolved::Stop { session } => {
                crate::eventlog::record(&app, Some(&session), "ui.session_stop_requested", &serde_json::json!({}), None);
                sc::session_stop(state(), session).map(|_| Value::Null)
            }
            Resolved::Start { cwd, workspace, prompt, kind } => {
                sc::start_now(app.clone(), state(), cwd, prompt, None, None, Some(kind), None, None, Some(workspace), None, None).map(|id| serde_json::json!({ "session": id }))
            }
            Resolved::LogUi { session, kind, payload, anchor } => {
                crate::eventlog::record(&app, session.as_deref(), &kind, &payload, anchor.as_deref()).ok_or("couldn't record it")?;
                // Archiving from the phone also stops the session, as the desktop's Done does.
                if kind == "ui.session_archived" && let Some(s) = &session {
                    let _ = sc::session_stop(state(), s.clone());
                }
                Ok(Value::Null)
            }
            Resolved::DocSend { doc_id, regenerate } => {
                let docs = app.state::<crate::docs::Docs>();
                let session = docs.get(&doc_id).and_then(|d| d.session_id.clone()).ok_or("this doc has no session to send to")?;
                let msg = crate::docs::doc_feedback(app.clone(), docs, doc_id, regenerate)?;
                sc::session_send(app.clone(), state(), session, msg, None).map(|_| Value::Null)
            }
            Resolved::RegisterPush { subscription } => {
                let sub: remote_push::Subscription = serde_json::from_value(subscription).map_err(|e| format!("bad push subscription: {e}"))?;
                let remote = app.state::<Remote>();
                let mut store = remote.load();
                store.push = Some(sub.clone());
                save_store(&remote.store_path(), &store);
                let host = sub.endpoint.split('/').nth(2).unwrap_or_default().to_owned();
                crate::eventlog::record(&app, None, "ui.remote_push_registered", &serde_json::json!({ "push_service": host }), None);
                let status = push_now(&app, &serde_json::json!({ "title": "Cockpit Remote", "body": "Notifications from this Mac are on." }))?;
                Ok(serde_json::json!({ "status": status }))
            }
        }
    }

    fn changed(&self) {
        use tauri::Emitter;
        let _ = self.0.emit("mr-remote", ());
    }
}

// ---------------------------------------------------------------------------------------------
// Web Push (decision 46): this Mac's own VAPID key, the phone's subscription, no server of ours

const PUSH_ACCOUNT: &str = "push-vapid";
/// The VAPID `sub` claim: who runs the sender. Push services only use it to reach the sender.
const PUSH_CONTACT: &str = "https://getcockpit.github.io";

/// This Mac's VAPID key: the Keychain for the installed app; a 0600 file under `MR_DATA_DIR`.
fn vapid(dir: &std::path::Path) -> Result<remote_push::Vapid, String> {
    let scratch = std::env::var("MR_DATA_DIR").is_ok_and(|d| !d.is_empty());
    let file = dir.join("remote-push.key");
    let existing = if scratch { std::fs::read_to_string(&file).ok() } else { crate::sys::keychain_find(KEYCHAIN_SERVICE, PUSH_ACCOUNT) };
    if let Some(v) = existing.and_then(|k| remote_push::Vapid::from_private(&k).ok()) {
        return Ok(v);
    }
    let v = remote_push::Vapid::generate();
    if scratch {
        std::fs::write(&file, v.private()).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
        }
    } else {
        crate::sys::keychain_set(KEYCHAIN_SERVICE, PUSH_ACCOUNT, &v.private())?;
    }
    Ok(v)
}

/// Sends one push to the paired phone, blocking. 404/410 means the subscription is gone: it's
/// dropped and the phone subscribes again next time it's open.
fn push_now(app: &tauri::AppHandle, payload: &Value) -> Result<u16, String> {
    use tauri::Manager;
    let remote = app.state::<Remote>();
    let mut store = remote.load();
    let sub = store.push.clone().ok_or("no phone has turned on notifications")?;
    let status = vapid(&remote.dir)?.send(&sub, payload.to_string().as_bytes(), PUSH_CONTACT)?;
    if status == 404 || status == 410 {
        store.push = None;
        save_store(&remote.store_path(), &store);
    }
    Ok(status)
}

/// What a needs-you row says on the lock screen: the session's title and the ask. The payload is
/// encrypted to the phone, so Apple's push service never sees it.
pub fn needs_you(kind: &str, payload: &Value, title: &str) -> Option<Value> {
    if kind != "sidecar.permission_request" || payload["auto_allowed"] == true {
        return None;
    }
    let tool = payload["tool"].as_str().unwrap_or("a tool");
    let input = &payload["input"];
    let body = if tool == "AskUserQuestion" {
        format!("Claude asks: {}", input["questions"][0]["question"].as_str().unwrap_or("a question"))
    } else {
        let what = input["command"].as_str().or(input["file_path"].as_str()).or(input["url"].as_str()).unwrap_or("");
        format!("Allow {tool}? {}", what.chars().take(140).collect::<String>()).trim().to_owned()
    };
    Some(serde_json::json!({ "title": title.chars().take(60).collect::<String>(), "body": body, "session": payload["session"], "tag": payload["session"] }))
}

/// Called from `eventlog::record` for every new row: pushes the needs-you ones to the phone, off
/// the calling thread.
pub fn on_event(app: &tauri::AppHandle, ev: &crate::eventlog::Event) {
    use tauri::Manager;
    if ev.kind != "sidecar.permission_request" {
        return;
    }
    let Some(remote) = app.try_state::<Remote>() else { return };
    if remote.shared().is_none() || remote.load().push.is_none() {
        return;
    }
    let (app, ev) = (app.clone(), ev.clone());
    std::thread::spawn(move || {
        let log = app.state::<crate::eventlog::EventLog>();
        let title = ev
            .session_id
            .as_deref()
            .and_then(|s| log.list(Some(s), None, 1).ok())
            .and_then(|rows| rows.into_iter().next())
            .and_then(|r| r.payload["prompt"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "Cockpit".into());
        if let Some(p) = needs_you(&ev.kind, &ev.payload, &title)
            && let Err(e) = push_now(&app, &p)
        {
            eprintln!("[remote] push failed: {e}");
        }
    });
}

/// Called from `eventlog::record` for every new row.
pub fn bump(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(r) = app.try_state::<Remote>() && let Some(s) = r.shared() {
        s.bump();
    }
}

/// Runs `fut` to completion on Tauri's runtime from any caller, including code already on that
/// runtime (where `block_on` would panic): it blocks a fresh thread instead.
fn wait<T: Send + 'static>(fut: impl std::future::Future<Output = T> + Send + 'static) -> T {
    std::thread::spawn(move || tauri::async_runtime::block_on(fut)).join().expect("remote runtime thread")
}

fn start_endpoint(app: &tauri::AppHandle, remote: &Remote, rotate: bool) -> Result<(), String> {
    let key = identity(&remote.dir, rotate)?;
    let store = remote.load();
    let path = remote.store_path();
    let save = Box::new(move |p: Option<&Phone>| {
        let mut s: Store = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        s.phone = p.cloned();
        save_store(&path, &s);
    });
    let shared = Shared::new(Box::new(AppHost(app.clone())), *key.public().as_bytes(), mac_name(), store.phone, save);
    match vapid(&remote.dir) {
        Ok(v) => shared.set_push_key(Some(v.public())),
        Err(e) => eprintln!("[remote] no push key: {e}"),
    }
    let router = wait(listen(shared.clone(), key, std::env::var("MR_REMOTE_LOCAL").is_ok()))?;
    *remote.running.lock().unwrap() = Some((shared, router));
    Ok(())
}

fn stop_endpoint(remote: &Remote) {
    if let Some((_, router)) = remote.running.lock().unwrap().take() {
        tauri::async_runtime::spawn(async move {
            let _ = router.shutdown().await;
        });
    }
}

// ---------------------------------------------------------------------------------------------
// Keep awake while sessions run (decision 45): with Remote on, a Mac that dozes off mid-turn
// leaves the phone with nothing. So while any session is mid-turn (that includes one waiting on
// your Allow), Cockpit holds an idle-sleep assertion; when all are idle, the Mac may sleep.
// A closed lid on battery still sleeps (macOS clamshell rule), which the Settings note says.

/// Whether to hold the assertion now.
pub fn want_awake(remote_on: bool, working: usize) -> bool {
    remote_on && working > 0
}

static AWAKE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn keep_awake(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use tauri::Manager;
        let mut held: Option<std::process::Child> = None;
        loop {
            let on = app.try_state::<Remote>().is_some_and(|r| r.shared().is_some());
            let working = app.try_state::<crate::sidecar::Sidecar>().map(|s| crate::sidecar::busy(&s)).unwrap_or(0);
            let want = want_awake(on, working);
            match (want, held.is_some()) {
                (true, false) => held = assert_awake(),
                (false, true) => {
                    if let Some(mut c) = held.take() {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                }
                _ => {}
            }
            AWAKE.store(held.is_some(), Ordering::Relaxed);
            // Two in-memory lookups: cheap enough to catch even a short turn.
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

/// `caffeinate -i -w <this pid>`: no idle sleep, and it ends by itself if Cockpit dies.
#[cfg(target_os = "macos")]
fn assert_awake() -> Option<std::process::Child> {
    std::process::Command::new("/usr/bin/caffeinate").args(["-i", "-w", &std::process::id().to_string()]).spawn().ok()
}

#[cfg(not(target_os = "macos"))]
fn assert_awake() -> Option<std::process::Child> {
    None
}

/// At app start: manage the state and bring the link up if Remote was left on.
pub fn start(app: &tauri::AppHandle, dir: &std::path::Path) {
    use tauri::Manager;
    app.manage(Remote { dir: dir.to_path_buf(), running: Mutex::new(None) });
    keep_awake(app.clone());
    let remote = app.state::<Remote>();
    if remote.load().enabled
        && let Err(e) = start_endpoint(app, &remote, false)
    {
        eprintln!("[remote] couldn't start: {e}");
    }
}

#[tauri::command(async)]
pub fn remote_status(remote: tauri::State<'_, Remote>) -> Value {
    let store = remote.load();
    let shared = remote.shared();
    let id = remote.running.lock().unwrap().as_ref().map(|(_, r)| r.endpoint().id().to_string());
    serde_json::json!({
        "enabled": store.enabled,
        "running": shared.is_some(),
        "mac_id": id,
        "phone": shared.as_ref().map(|s| s.phone()).unwrap_or(store.phone),
        "pending": shared.as_ref().and_then(|s| s.pending()).map(|(code, name)| serde_json::json!({ "code": code, "name": name })),
        "connected": shared.as_ref().is_some_and(|s| s.connected()),
        "last_seen": shared.as_ref().map(|s| s.last_seen()).filter(|t| *t > 0),
        "awake": AWAKE.load(Ordering::Relaxed),
    })
}

#[tauri::command(async)]
pub fn remote_set_enabled(app: tauri::AppHandle, remote: tauri::State<'_, Remote>, on: bool) -> Result<(), String> {
    let mut store = remote.load();
    if on && remote.shared().is_none() {
        start_endpoint(&app, &remote, false)?;
    }
    if !on {
        if let Some(s) = remote.shared() {
            for c in s.conns.lock().unwrap().drain(..) {
                c.close(4u32.into(), b"remote off");
            }
        }
        stop_endpoint(&remote);
    }
    store.enabled = on;
    // The phone may have changed while running; keep the file's phone.
    store.phone = remote.load().phone;
    save_store(&remote.store_path(), &store);
    crate::eventlog::record(&app, None, if on { "ui.remote_enabled" } else { "ui.remote_disabled" }, &serde_json::json!({}), None);
    Ok(())
}

/// A fresh QR (2 min, single use). Waits up to a few seconds for the relay address so the code
/// works off the home network too.
#[tauri::command(async)]
pub fn remote_pair_start(remote: tauri::State<'_, Remote>) -> Result<Value, String> {
    let (shared, ep) = remote.running.lock().unwrap().as_ref().map(|(s, r)| (s.clone(), r.endpoint().clone())).ok_or("turn Remote on first")?;
    let ep2 = ep.clone();
    wait(async move {
        let _ = tokio::time::timeout(Duration::from_secs(5), ep2.online()).await;
    });
    let offer = shared.offer(ep.addr());
    let text = offer.to_text();
    // The QR is a link to the web app with the code after the #, so the iPhone camera opens it;
    // the part after # never reaches the site.
    let link = format!("{WEB_APP}#{text}");
    let svg = qrcode::QrCode::new(link.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build();
    Ok(serde_json::json!({ "text": text, "link": link, "svg": svg, "expires_at": offer.expires_at }))
}

#[tauri::command(async)]
pub fn remote_pair_answer(app: tauri::AppHandle, remote: tauri::State<'_, Remote>, accept: bool) -> Result<(), String> {
    let shared = remote.shared().ok_or("Remote is off")?;
    let name = shared.pending().map(|(_, n)| n).unwrap_or_default();
    shared.answer(accept)?;
    if accept {
        crate::eventlog::record(&app, None, "ui.remote_paired", &serde_json::json!({ "name": name }), None);
    }
    Ok(())
}

/// Forgets the phone, cuts its link, and rotates the Mac's key so old QR data is useless.
#[tauri::command(async)]
pub fn remote_unpair(app: tauri::AppHandle, remote: tauri::State<'_, Remote>) -> Result<(), String> {
    if let Some(s) = remote.shared() {
        s.unpair();
    }
    let mut store = remote.load();
    store.phone = None;
    store.push = None;
    save_store(&remote.store_path(), &store);
    let was_running = remote.shared().is_some();
    stop_endpoint(&remote);
    if was_running {
        start_endpoint(&app, &remote, true)?;
    } else {
        identity(&remote.dir, true)?;
    }
    crate::eventlog::record(&app, None, "ui.remote_unpaired", &serde_json::json!({}), None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use remote_link::proto::{KnownRepo, KnownWorkspace};
    use remote_link::Peer;

    /// A fake app: an in-memory log and a record of what ran.
    struct Fake {
        rows: Mutex<Vec<Stored>>,
        ran: Mutex<Vec<Resolved>>,
    }

    impl Fake {
        fn push(&self, kind: &str, session: Option<&str>) -> String {
            let mut rows = self.rows.lock().unwrap();
            let id = format!("{:04}", rows.len() + 1);
            let json = serde_json::json!({ "id": id, "kind": kind, "session_id": session, "payload": {}, "created_at": 0 }).to_string();
            rows.push(Stored { id: id.clone(), kind: kind.into(), session_id: session.map(Into::into), created_at: 0, json });
            id
        }
    }

    impl Host for Arc<Fake> {
        fn now_rows(&self) -> (Vec<Stored>, String) {
            let rows = self.rows.lock().unwrap().clone();
            let upto = rows.last().map(|r| r.id.clone()).unwrap_or_default();
            let mut l = Light::default();
            (rows.into_iter().filter(|r| l.keep(r)).collect(), upto)
        }
        fn events_after(&self, after: &str, limit: usize) -> Vec<Stored> {
            self.rows.lock().unwrap().iter().filter(|r| r.id.as_str() > after).take(limit).cloned().collect()
        }
        fn event(&self, id: &str) -> Option<Stored> {
            self.rows.lock().unwrap().iter().find(|r| r.id == id).cloned()
        }
        fn session_rows(&self, session: &str, limit: usize) -> Vec<Stored> {
            let rows: Vec<Stored> = self.rows.lock().unwrap().iter().filter(|r| r.session_id.as_deref() == Some(session)).cloned().collect();
            rows[rows.len().saturating_sub(limit)..].to_vec()
        }
        fn known(&self) -> Known {
            Known { workspaces: vec![KnownWorkspace { id: "personal".into(), name: "Personal".into() }], repos: vec![KnownRepo { id: "r1".into(), name: "app".into(), path: "/u/app".into() }] }
        }
        fn session_exists(&self, id: &str) -> bool {
            self.rows.lock().unwrap().iter().any(|r| r.session_id.as_deref() == Some(id))
        }
        fn run(&self, cmd: Resolved) -> Result<Value, String> {
            assert!(tag("ui.x", &Value::Null).is_some(), "commands run as the phone");
            self.ran.lock().unwrap().push(cmd);
            Ok(Value::Null)
        }
    }

    async fn mac() -> (Arc<Fake>, Arc<Shared>, Router) {
        let fake = Arc::new(Fake { rows: Mutex::new(Vec::new()), ran: Mutex::new(Vec::new()) });
        let key = SecretKey::generate();
        let shared = Shared::new(Box::new(fake.clone()), *key.public().as_bytes(), "Test Mac".into(), None, Box::new(|_| {}));
        let router = listen(shared.clone(), key, true).await.unwrap();
        (fake, shared, router)
    }

    /// Pairs `phone` through the real handshake, confirming on the "Mac" when the code shows.
    async fn pair(shared: &Arc<Shared>, router: &Router, phone: &Peer) -> Result<String, String> {
        let offer = shared.offer(router.endpoint().addr());
        let s = shared.clone();
        let confirm = tokio::spawn(async move {
            for _ in 0..1500 {
                if s.pending().is_some() {
                    return s.answer(true);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err("no pending pairing".into())
        });
        let mut shown = String::new();
        let t = std::time::Instant::now();
        let mac = phone.pair(&offer, "Test iPhone", |c| shown = c.to_owned()).await?;
        confirm.await.unwrap()?;
        eprintln!("paired in {:?}", t.elapsed());
        assert_eq!(shown.len(), 6);
        Ok(mac)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pairs_streams_after_cursor_and_runs_commands() {
        let (fake, shared, router) = mac().await;
        let a = fake.push("ui.session_requested", Some("s1"));
        fake.push("sidecar.commands", Some("s1"));
        let phone = Peer::bind(SecretKey::generate(), true).await.unwrap();
        assert_eq!(pair(&shared, &router, &phone).await.unwrap(), "Test Mac");
        assert_eq!(shared.phone().unwrap().name, "Test iPhone");

        // Catch-up after the cursor skips what the phone has and what it never renders.
        let b = fake.push("ui.message_sent", Some("s1"));
        let mut link = phone.link(router.endpoint().addr(), &a).await.unwrap();
        assert_eq!(link.known.repos[0].id, "r1");
        assert!(!serde_json::to_string(&link.known).unwrap().contains("/u/app"));
        let got = link.until_live().await.unwrap();
        assert_eq!(got, vec![b.clone()]);

        // Live rows arrive as they're written.
        let c = fake.push("sidecar.sdk", Some("s1"));
        shared.bump();
        assert_eq!(link.next_ids().await.unwrap(), vec![c.clone()]);

        // A phone that synced light asks for one session's transcript.
        link.send(&Frame::FetchSession { id: "f1".into(), session: "s1".into() }).await.unwrap();
        loop {
            if let Frame::SessionRows { id, session, events } = link.next().await.unwrap() {
                assert_eq!((id.as_str(), session.as_str()), ("f1", "s1"));
                let ids: Vec<&str> = events.iter().filter_map(|e| e["id"].as_str()).collect();
                assert_eq!(ids, vec![a.as_str(), b.as_str(), c.as_str()], "its rows, oldest first, desktop-only kinds left out");
                break;
            }
        }

        // Allowlisted commands run; unknown sessions and repos are refused.
        let ack = link.command(Command::SendPrompt { session: "s1".into(), text: "hi".into() }).await.unwrap();
        assert!(ack.is_ok(), "{ack:?}");
        let ack = link.command(Command::SendPrompt { session: "nope".into(), text: "hi".into() }).await.unwrap();
        assert!(ack.unwrap_err().contains("unknown session"));
        let ack = link.command(Command::StartSession { workspace_id: "personal".into(), repo_id: "r1".into(), prompt: "go".into(), kind: None }).await.unwrap();
        assert!(ack.is_ok());
        let ack = link.command(Command::StartSession { workspace_id: "personal".into(), repo_id: "/etc".into(), prompt: "go".into(), kind: None }).await.unwrap();
        assert!(ack.is_err());
        let ran = fake.ran.lock().unwrap().clone();
        assert_eq!(ran, vec![Resolved::Send { session: "s1".into(), text: "hi".into() }, Resolved::Start { cwd: "/u/app".into(), workspace: "personal".into(), prompt: "go".into(), kind: "blank".into() }]);

        // Unpair cuts the live link, and the phone can't come back.
        shared.unpair();
        assert!(link.next_ids().await.is_err(), "link closed");
        assert!(phone.link(router.endpoint().addr(), "").await.is_err());
        router.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn strangers_and_wrong_codes_get_nothing() {
        let (fake, shared, router) = mac().await;
        fake.push("ui.session_requested", Some("s1"));
        let phone = Peer::bind(SecretKey::generate(), true).await.unwrap();
        pair(&shared, &router, &phone).await.unwrap();

        // Another device (same app, its own key) is dropped before any data.
        let stranger = Peer::bind(SecretKey::generate(), true).await.unwrap();
        assert!(stranger.link(router.endpoint().addr(), "").await.is_err());

        // A forged QR (right Mac, wrong secret) fails and spends the real offer.
        let mut forged = shared.offer(router.endpoint().addr());
        forged.secret = data_encoding::HEXLOWER.encode(&[0u8; 16]);
        let e = stranger.pair(&forged, "evil", |_| {}).await.unwrap_err();
        assert!(e.contains("didn't scan"), "{e}");
        assert!(shared.pending().is_none());
        // Reusing a spent or expired QR fails too.
        let o = shared.offer(router.endpoint().addr());
        *shared.offer.lock().unwrap() = None;
        assert!(stranger.pair(&o, "evil", |_| {}).await.is_err());
        assert_eq!(shared.phone().unwrap().name, "Test iPhone", "the pinned phone is unchanged");
        router.shutdown().await.unwrap();
    }

    /// A WebAuthn assertion as Safari makes one, from a test passkey.
    fn webauthn(sk: &p256::ecdsa::SigningKey, json: &str, nonce: &str) -> proto::Proof {
        use p256::ecdsa::signature::Signer;
        use sha2::{Digest, Sha256};
        let e = |b: &[u8]| data_encoding::BASE64URL_NOPAD.encode(b);
        let cd = serde_json::json!({ "type": "webauthn.get", "challenge": proto::challenge(nonce, json), "origin": proto::ORIGIN }).to_string();
        let mut ad = Sha256::digest(proto::RP_ID.as_bytes()).to_vec();
        ad.extend_from_slice(&[0x05, 0, 0, 0, 0]);
        let mut signed = ad.clone();
        signed.extend_from_slice(&Sha256::digest(cd.as_bytes()));
        let sig: p256::ecdsa::Signature = sk.sign(&signed);
        proto::Proof { json: json.into(), credential_id: "Y3JlZA".into(), authenticator_data: e(&ad), client_data_json: e(cd.as_bytes()), signature: e(sig.to_der().as_bytes()) }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_web_phone_needs_face_id_for_what_runs_claude() {
        use p256::pkcs8::EncodePublicKey;
        let (fake, shared, router) = mac().await;
        fake.push("ui.session_requested", Some("s1"));
        let sk = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        let passkey = proto::Passkey { credential_id: "Y3JlZA".into(), public_key: data_encoding::BASE64URL_NOPAD.encode(sk.verifying_key().to_public_key_der().unwrap().as_bytes()) };
        let offer = shared.offer(router.endpoint().addr());
        let s = shared.clone();
        tokio::spawn(async move {
            while s.pending().is_none() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            s.answer(true).unwrap();
        });
        let phone = Peer::bind(SecretKey::generate(), true).await.unwrap();
        phone.pair_with_passkey(&offer, "Web iPhone", Some(passkey.clone()), |_| {}).await.unwrap();
        assert_eq!(shared.phone().unwrap().passkey, Some(passkey), "bound at pairing");

        let mut link = phone.link(router.endpoint().addr(), "").await.unwrap();
        link.until_live().await.unwrap();
        let start = Command::StartSession { workspace_id: "personal".into(), repo_id: "r1".into(), prompt: "go".into(), kind: None };
        let json = serde_json::to_string(&start).unwrap();
        // No proof: refused.
        let r = link.command(start.clone()).await.unwrap();
        assert!(r.unwrap_err().contains("Face ID"));
        // A proof on another link's nonce: refused.
        let id = link.send_command_proved(start.clone(), Some(webauthn(&sk, &json, "other-link"))).await.unwrap();
        assert!(wait_ack(&mut link, &id).await.unwrap_err().contains("something else"));
        // A proof over a different command: refused.
        let other = serde_json::to_string(&Command::StartSession { workspace_id: "personal".into(), repo_id: "r1".into(), prompt: "rm".into(), kind: None }).unwrap();
        let id = link.send_command_proved(start.clone(), Some(webauthn(&sk, &other, &link.nonce.clone()))).await.unwrap();
        assert!(wait_ack(&mut link, &id).await.is_err());
        // The real thing: runs once.
        let good = webauthn(&sk, &json, &link.nonce.clone());
        let id = link.send_command_proved(start.clone(), Some(good.clone())).await.unwrap();
        wait_ack(&mut link, &id).await.unwrap();
        let id = link.send_command_proved(start.clone(), Some(good)).await.unwrap();
        assert!(wait_ack(&mut link, &id).await.unwrap_err().contains("already used"));
        // Deny and replies need no Face ID.
        let deny = Command::PermissionResponse { session: "s1".into(), request_id: "r".into(), decision: serde_json::json!({ "behavior": "deny", "message": "no" }) };
        assert!(link.command(deny).await.unwrap().is_ok());
        assert_eq!(fake.ran.lock().unwrap().iter().filter(|r| matches!(r, Resolved::Start { .. })).count(), 1);
        router.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_phone_records_the_desktops_actions_and_reads_docs() {
        let (fake, shared, router) = mac().await;
        fake.push("ui.session_requested", Some("s1"));
        let phone = Peer::bind(SecretKey::generate(), true).await.unwrap();
        pair(&shared, &router, &phone).await.unwrap();
        let mut link = phone.link(router.endpoint().addr(), "").await.unwrap();
        link.until_live().await.unwrap();
        // A review note, as the desktop's Flows screen writes it.
        let note = Command::LogUi { session: Some("s1".into()), kind: "ui.review_noted".into(), payload: serde_json::json!({ "finding_id": "f1" }), anchor: Some("review:f1".into()) };
        assert!(link.command(note.clone()).await.unwrap().is_ok());
        // Nothing outside the list, and only for sessions that exist.
        let shell = Command::LogUi { session: Some("s1".into()), kind: "ui.terminal_opened".into(), payload: serde_json::json!({}), anchor: None };
        assert!(link.command(shell).await.unwrap().is_err());
        let ghost = Command::LogUi { session: Some("nope".into()), kind: "ui.review_noted".into(), payload: serde_json::json!({}), anchor: None };
        assert!(link.command(ghost).await.unwrap().is_err());
        // A review start from the phone (no passkey here: the phone gates it itself).
        let review = Command::StartSession { workspace_id: "personal".into(), repo_id: "r1".into(), prompt: "/review 12".into(), kind: Some("review".into()) };
        assert!(link.command(review).await.unwrap().is_ok());
        let ran = fake.ran.lock().unwrap().clone();
        assert!(ran.contains(&Resolved::LogUi { session: Some("s1".into()), kind: "ui.review_noted".into(), payload: serde_json::json!({ "finding_id": "f1" }), anchor: Some("review:f1".into()) }));
        assert!(ran.contains(&Resolved::Start { cwd: "/u/app".into(), workspace: "personal".into(), prompt: "/review 12".into(), kind: "review".into() }));
        // Docs on request.
        link.send(&Frame::FetchDocs { id: "d1".into() }).await.unwrap();
        loop {
            if let Frame::Docs { id, docs } = link.next().await.unwrap() {
                assert_eq!(id, "d1");
                assert!(docs.is_empty(), "the fake Mac has none");
                break;
            }
        }
        router.shutdown().await.unwrap();
    }

    async fn wait_ack(link: &mut remote_link::Link, id: &str) -> Result<(), String> {
        loop {
            if let Frame::Ack { id: got, ok, error, .. } = link.next().await.unwrap() && got == id {
                return if ok { Ok(()) } else { Err(error.unwrap_or_default()) };
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn declined_on_the_mac_pins_nothing() {
        let (_fake, shared, router) = mac().await;
        let offer = shared.offer(router.endpoint().addr());
        let s = shared.clone();
        tokio::spawn(async move {
            while s.pending().is_none() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            s.answer(false).unwrap();
        });
        let phone = Peer::bind(SecretKey::generate(), true).await.unwrap();
        assert!(phone.pair(&offer, "p", |_| {}).await.unwrap_err().contains("declined"));
        assert!(shared.phone().is_none());
        router.shutdown().await.unwrap();
    }

    /// Over the real internet: both ends on n0's presets, the phone dials by key alone, so address
    /// lookup and the relay (or a hole punch) do the work. `cargo test remote_over_n0 -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn remote_over_n0() {
        let fake = Arc::new(Fake { rows: Mutex::new(Vec::new()), ran: Mutex::new(Vec::new()) });
        fake.push("ui.session_requested", Some("s1"));
        let key = SecretKey::generate();
        let shared = Shared::new(Box::new(fake.clone()), *key.public().as_bytes(), "Net Mac".into(), None, Box::new(|_| {}));
        let router = listen(shared.clone(), key, false).await.unwrap();
        router.endpoint().online().await;
        let phone = Peer::bind(SecretKey::generate(), false).await.unwrap();
        pair(&shared, &router, &phone).await.unwrap();
        let t = std::time::Instant::now();
        let mut link = phone.link(iroh::EndpointAddr::new(router.endpoint().id()), "").await.unwrap();
        assert_eq!(link.until_live().await.unwrap().len(), 1);
        eprintln!("linked by key alone in {:?}", t.elapsed());
        router.shutdown().await.unwrap();
    }

    #[test]
    fn light_follows_sessions_as_they_start_and_get_archived() {
        let row = |sid: Option<&str>, kind: &str, payload: serde_json::Value| Stored { id: "1".into(), kind: kind.into(), session_id: sid.map(Into::into), created_at: 0, json: serde_json::json!({ "kind": kind, "payload": payload }).to_string() };
        let mut l = Light::default();
        assert!(l.keep(&row(None, "ui.workspace_created", serde_json::json!({}))));
        assert!(!l.keep(&row(None, "sidecar.limits", serde_json::json!({}))));
        assert!(!l.keep(&row(Some("s"), "sidecar.permission_request", serde_json::json!({}))), "unknown session");
        assert!(l.keep(&row(Some("s"), "ui.session_requested", serde_json::json!({}))));
        assert!(l.keep(&row(Some("s"), "sidecar.permission_request", serde_json::json!({}))));
        assert!(!l.keep(&row(Some("s"), "sidecar.sdk", serde_json::json!({ "message": { "type": "assistant" } }))));
        assert!(l.keep(&row(Some("s"), "sidecar.sdk", serde_json::json!({ "message": { "type": "result" } }))));
        assert!(l.keep(&row(Some("s"), "ui.session_archived", serde_json::json!({}))), "the phone learns it's archived");
        assert!(!l.keep(&row(Some("s"), "ui.message_sent", serde_json::json!({}))));
    }

    #[test]
    fn light_turn_ends_drop_the_usage_detail() {
        let row = |json: serde_json::Value| Stored { id: "1".into(), kind: "sidecar.sdk".into(), session_id: Some("s".into()), created_at: 0, json: json.to_string() };
        let big = row(serde_json::json!({ "id": "1", "kind": "sidecar.sdk", "payload": { "session": "s", "message": { "type": "result", "is_error": false, "result": "done", "usage": { "x": "y".repeat(3000) }, "modelUsage": {} } } }));
        let v: serde_json::Value = serde_json::from_str(&slim(big).json).unwrap();
        assert_eq!(v["payload"]["message"]["result"], "done");
        assert_eq!(v["payload"]["message"]["is_error"], false);
        assert!(v["payload"]["message"].get("usage").is_none());
        assert_eq!(v["payload"]["session"], "s", "the rest of the row is untouched");
        let other = row(serde_json::json!({ "payload": { "message": { "type": "assistant", "usage": {} } } }));
        assert_eq!(slim(other.clone()).json, other.json);
    }

    #[test]
    fn needs_you_pushes_say_what_and_where() {
        let ask = serde_json::json!({ "session": "s1", "tool": "Bash", "input": { "command": "rm -rf build" } });
        let p = needs_you("sidecar.permission_request", &ask, "Clean the build").unwrap();
        assert_eq!(p["title"], "Clean the build");
        assert_eq!(p["body"], "Allow Bash? rm -rf build");
        assert_eq!(p["tag"], "s1");
        let q = serde_json::json!({ "session": "s1", "tool": "AskUserQuestion", "input": { "questions": [{ "question": "Which DB?" }] } });
        assert_eq!(needs_you("sidecar.permission_request", &q, "t").unwrap()["body"], "Claude asks: Which DB?");
        let auto = serde_json::json!({ "session": "s1", "tool": "Read", "auto_allowed": true });
        assert!(needs_you("sidecar.permission_request", &auto, "t").is_none(), "Never ask: nothing to tap");
        assert!(needs_you("sidecar.sdk", &ask, "t").is_none());
    }

    #[test]
    fn awake_only_while_remote_is_on_and_a_session_works() {
        assert!(want_awake(true, 1));
        assert!(!want_awake(true, 0), "idle: the Mac may sleep");
        assert!(!want_awake(false, 3), "Remote off: Cockpit doesn't hold the Mac");
    }

    #[test]
    fn only_phone_commands_are_tagged() {
        assert_eq!(tag("ui.message_sent", &serde_json::json!({ "text": "a" })), None);
        let t = as_phone(|| tag("ui.message_sent", &serde_json::json!({ "text": "a" })));
        assert_eq!(t.unwrap()["origin"], "remote");
        assert_eq!(as_phone(|| tag("sidecar.sdk", &serde_json::json!({}))), None);
        assert_eq!(tag("ui.message_sent", &serde_json::json!({})), None, "flag resets");
    }
}
