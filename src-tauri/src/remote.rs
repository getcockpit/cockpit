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
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

use crate::remote_proto::{self as proto, Command, Frame, Known, Offer, StartLimit};

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
    Start { cwd: String, workspace: String, prompt: String },
}

pub trait Host: Send + Sync + 'static {
    /// Rows after `after` (exclusive), ULID order, at most `limit`.
    fn events_after(&self, after: &str, limit: usize) -> Vec<Stored>;
    fn event(&self, id: &str) -> Option<Stored>;
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
            save,
        })
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
            Command::StartSession { workspace_id, repo_id, prompt } => {
                let known = self.host.known();
                let repo = known.repos.iter().find(|r| r.id == repo_id).ok_or("unknown repo: start it once on the Mac first")?;
                if !known.workspaces.iter().any(|w| w.id == workspace_id) {
                    return Err("unknown workspace".into());
                }
                self.starts.lock().unwrap().take(proto::now_ms())?;
                Resolved::Start { cwd: repo.path.clone(), workspace: workspace_id, prompt }
            }
        })
    }

    fn execute(&self, cmd: Command) -> Result<Value, String> {
        let r = self.resolve(cmd)?;
        as_phone(|| self.host.run(r))
    }

    fn is_pinned(&self, key: &PublicKey) -> bool {
        self.phone.lock().unwrap().as_ref().is_some_and(|p| p.key == key.to_string())
    }
}

// ---------------------------------------------------------------------------------------------
// Frames over a QUIC stream

/// Reads one frame (None at the end of the stream). Lines over `MAX_LINE` are an error.
pub async fn read_frame<R: AsyncBufRead + Unpin>(r: &mut R) -> Result<Option<Frame>, String> {
    let mut buf = Vec::new();
    let n = (&mut *r).take(proto::MAX_LINE as u64 + 1).read_until(b'\n', &mut buf).await.map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(None);
    }
    if buf.len() > proto::MAX_LINE {
        return Err("frame too big".into());
    }
    serde_json::from_slice(&buf).map(Some).map_err(|e| format!("bad frame: {e}"))
}

pub async fn write_frame(s: &mut SendStream, f: &Frame) -> Result<(), String> {
    s.write_all(f.line().as_bytes()).await.map_err(|e| e.to_string())
}

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
        let Ok(Some(Frame::Pair { proof, name })) = tokio::time::timeout(Duration::from_secs(30), read_frame(&mut recv)).await.unwrap_or(Ok(None)) else {
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
        let phone = Phone { key: conn.remote_id().to_string(), name, paired_at: proto::now_ms() };
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
    async fn catch_up(&self, send: &mut SendStream, mut cursor: String) -> Result<String, String> {
        loop {
            let shared = self.0.clone();
            let after = cursor.clone();
            let rows = tokio::task::spawn_blocking(move || shared.host.events_after(&after, 500)).await.map_err(|e| e.to_string())?;
            let Some(last) = rows.last() else { return Ok(cursor) };
            cursor = last.id.clone();
            let full = rows.len() == 500;
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
            if !full {
                return Ok(cursor);
            }
        }
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
        let cursor = match tokio::time::timeout(Duration::from_secs(30), frames.recv()).await {
            Ok(Some(Ok(Frame::Hello { v, cursor }))) if v == proto::VERSION => cursor,
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
        write_frame(&mut send, &Frame::Welcome { v: proto::VERSION, mac: shared.name.clone(), known }).await?;
        let mut cursor = self.catch_up(&mut send, cursor).await?;
        write_frame(&mut send, &Frame::Live { cursor: cursor.clone() }).await?;
        loop {
            tokio::select! {
                changed = tick.changed() => {
                    if changed.is_err() { return Ok(()) }
                    cursor = self.catch_up(&mut send, cursor).await?;
                }
                frame = frames.recv() => {
                    shared.last_seen.store(proto::now_ms(), Ordering::Relaxed);
                    let reply = match frame {
                        None => return Ok(()),
                        Some(Err(e)) => Frame::Error { error: e },
                        Some(Ok(Frame::Command { id, command })) => {
                            let s = shared.clone();
                            let out = tokio::task::spawn_blocking(move || s.execute(command)).await.map_err(|e| e.to_string())?;
                            match out {
                                Ok(result) => Frame::Ack { id, ok: true, result: Some(result), error: None },
                                Err(e) => Frame::Ack { id, ok: false, result: None, error: Some(e) },
                            }
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
}

const KEYCHAIN_SERVICE: &str = "cockpit-remote";
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

fn stored(w: crate::eventlog::WireEvent) -> Option<Stored> {
    Some(Stored { id: w.id.clone(), kind: w.kind.clone(), session_id: w.session_id.clone(), created_at: w.created_at, json: serde_json::to_string(&w).ok()? })
}

impl Host for AppHost {
    fn events_after(&self, after: &str, limit: usize) -> Vec<Stored> {
        use tauri::Manager;
        let log = self.0.state::<crate::eventlog::EventLog>();
        // Like the desktop's first load: archived sessions come without their transcripts.
        log.list_wire(None, Some(after), limit as i64, true).unwrap_or_default().into_iter().filter_map(stored).collect()
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
            Resolved::Start { cwd, workspace, prompt } => {
                sc::start_now(app.clone(), state(), cwd, prompt, None, None, Some("blank".into()), None, None, Some(workspace), None, None).map(|id| serde_json::json!({ "session": id }))
            }
        }
    }

    fn changed(&self) {
        use tauri::Emitter;
        let _ = self.0.emit("mr-remote", ());
    }
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

/// At app start: manage the state and bring the link up if Remote was left on.
pub fn start(app: &tauri::AppHandle, dir: &std::path::Path) {
    use tauri::Manager;
    app.manage(Remote { dir: dir.to_path_buf(), running: Mutex::new(None) });
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
    let svg = qrcode::QrCode::new(text.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build();
    Ok(serde_json::json!({ "text": text, "svg": svg, "expires_at": offer.expires_at }))
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
    use crate::remote_peer::Peer;
    use crate::remote_proto::{KnownRepo, KnownWorkspace};

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
        fn events_after(&self, after: &str, limit: usize) -> Vec<Stored> {
            self.rows.lock().unwrap().iter().filter(|r| r.id.as_str() > after).take(limit).cloned().collect()
        }
        fn event(&self, id: &str) -> Option<Stored> {
            self.rows.lock().unwrap().iter().find(|r| r.id == id).cloned()
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
        assert_eq!(link.next_ids().await.unwrap(), vec![c]);

        // Allowlisted commands run; unknown sessions and repos are refused.
        let ack = link.command(Command::SendPrompt { session: "s1".into(), text: "hi".into() }).await.unwrap();
        assert!(ack.is_ok(), "{ack:?}");
        let ack = link.command(Command::SendPrompt { session: "nope".into(), text: "hi".into() }).await.unwrap();
        assert!(ack.unwrap_err().contains("unknown session"));
        let ack = link.command(Command::StartSession { workspace_id: "personal".into(), repo_id: "r1".into(), prompt: "go".into() }).await.unwrap();
        assert!(ack.is_ok());
        let ack = link.command(Command::StartSession { workspace_id: "personal".into(), repo_id: "/etc".into(), prompt: "go".into() }).await.unwrap();
        assert!(ack.is_err());
        let ran = fake.ran.lock().unwrap().clone();
        assert_eq!(ran, vec![Resolved::Send { session: "s1".into(), text: "hi".into() }, Resolved::Start { cwd: "/u/app".into(), workspace: "personal".into(), prompt: "go".into() }]);

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
    fn only_phone_commands_are_tagged() {
        assert_eq!(tag("ui.message_sent", &serde_json::json!({ "text": "a" })), None);
        let t = as_phone(|| tag("ui.message_sent", &serde_json::json!({ "text": "a" })));
        assert_eq!(t.unwrap()["origin"], "remote");
        assert_eq!(as_phone(|| tag("sidecar.sdk", &serde_json::json!({}))), None);
        assert_eq!(tag("ui.message_sent", &serde_json::json!({})), None, "flag resets");
    }
}
