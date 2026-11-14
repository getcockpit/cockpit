//! Cockpit Remote's wire protocol (doc "Cockpit Remote: phone ↔ laptop, no server"): what the Mac
//! and the paired phone say to each other over iroh. Pure code, no app state, so the Mac
//! (`src-tauri/src/remote.rs`), the phone (`peer.rs`, the iOS app in `mobile/`) and the tests
//! share one definition.
//!
//! - Two ALPNs: `PAIR` (one-time, bound to the QR secret) and `LINK` (pinned phone only).
//! - Frames are one JSON object per line, at most `MAX_LINE` bytes.
//! - Commands are a closed allowlist (`Command`): no shell, file read or "run this" exists.

use std::collections::BTreeMap;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const ALPN_PAIR: &[u8] = b"cockpit/remote-pair/1";
pub const ALPN_LINK: &[u8] = b"cockpit/remote/1";
pub const VERSION: u32 = 1;
/// One frame. Bigger events go out as `remote.truncated` and the phone fetches them on demand.
pub const MAX_LINE: usize = 1 << 20;
/// Events above this size are not streamed (raw tool output, screenshots): the phone asks for them.
pub const MAX_EVENT_BYTES: usize = 64 * 1024;
/// Kinds the phone never renders: the slash-command lists are big and desktop-only.
pub const SKIP_KINDS: &[&str] = &["sidecar.commands"];
/// Rows `FetchSession` returns: enough for the visible transcript, small enough for the relay.
pub const SESSION_ROWS: usize = 300;
/// How long a pairing QR is good for.
pub const OFFER_TTL_MS: i64 = 120_000;
/// Remote session starts allowed per hour (the security block: a stolen phone can't fan out).
pub const STARTS_PER_HOUR: usize = 5;
/// The workspace every Mac has (`src-tauri/src/workspaces.rs`).
pub const PERSONAL: &str = "personal";
const QR_PREFIX: &str = "cockpit-remote:1:";

type HmacSha256 = Hmac<Sha256>;

/// What the Mac's QR code carries: how to dial it, which key to expect, and the one-time secret.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Offer {
    /// The Mac's endpoint: its public key plus the relay and direct addresses it knew at the time.
    pub mac: iroh::EndpointAddr,
    /// 128-bit one-time pairing secret, hex.
    pub secret: String,
    /// Unix ms after which the Mac refuses it.
    pub expires_at: i64,
    /// The Mac's name, for the phone's "Pair with …" screen.
    pub name: String,
}

impl Offer {
    pub fn to_text(&self) -> String {
        format!("{QR_PREFIX}{}", data_encoding::BASE64URL_NOPAD.encode(serde_json::to_string(self).unwrap_or_default().as_bytes()))
    }

    pub fn from_text(text: &str) -> Result<Self, String> {
        let body = text.trim().strip_prefix(QR_PREFIX).ok_or("not a Cockpit Remote pairing code")?;
        let raw = data_encoding::BASE64URL_NOPAD.decode(body.as_bytes()).map_err(|_| "damaged pairing code")?;
        serde_json::from_slice(&raw).map_err(|e| format!("damaged pairing code: {e}"))
    }

    pub fn secret_bytes(&self) -> Result<[u8; 16], String> {
        let v = data_encoding::HEXLOWER.decode(self.secret.as_bytes()).map_err(|_| "bad secret")?;
        v.try_into().map_err(|_| "bad secret".to_string())
    }
}

pub fn new_secret() -> [u8; 16] {
    let mut s = [0u8; 16];
    getrandom::fill(&mut s).expect("OS randomness");
    s
}

fn mac_over(secret: &[u8], label: &[u8], mac_key: &[u8; 32], phone_key: &[u8; 32]) -> HmacSha256 {
    let mut m = HmacSha256::new_from_slice(secret).expect("any key length");
    m.update(label);
    m.update(mac_key);
    m.update(phone_key);
    m
}

/// The phone's proof that it saw the QR: binds the secret to both keys the TLS handshake already
/// authenticated, so a MITM without the QR, or with a different key, can't pair.
pub fn pair_proof(secret: &[u8], mac_key: &[u8; 32], phone_key: &[u8; 32]) -> String {
    data_encoding::HEXLOWER.encode(&mac_over(secret, b"cockpit-remote/pair/1", mac_key, phone_key).finalize().into_bytes())
}

/// Constant-time check of `pair_proof`.
pub fn proof_ok(secret: &[u8], mac_key: &[u8; 32], phone_key: &[u8; 32], proof: &str) -> bool {
    let Ok(bytes) = data_encoding::HEXLOWER.decode(proof.as_bytes()) else { return false };
    mac_over(secret, b"cockpit-remote/pair/1", mac_key, phone_key).verify_slice(&bytes).is_ok()
}

/// The 6-digit code both screens show; you confirm on the Mac that they match.
pub fn short_code(secret: &[u8], mac_key: &[u8; 32], phone_key: &[u8; 32]) -> String {
    let out = mac_over(secret, b"cockpit-remote/code/1", mac_key, phone_key).finalize().into_bytes();
    format!("{:06}", u32::from_be_bytes([out[0], out[1], out[2], out[3]]) % 1_000_000)
}

/// One line on the wire, either direction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Frame {
    // Pairing (ALPN_PAIR)
    Pair { proof: String, name: String },
    Confirm { code: String },
    Paired { mac: String },
    // Link (ALPN_LINK)
    /// `light`: the phone wants "now", not the history: the rows of sessions that aren't archived
    /// (starts, asks, answers, messages, titles, turn ends) and the workspaces. On a 2 GB log that's
    /// ~0.2 MB instead of ~930 MB, which matters over a relay (browsers can't connect directly).
    Hello { v: u32, cursor: String, #[serde(default, skip_serializing_if = "std::ops::Not::not")] light: bool },
    /// `push_key`: the Mac's VAPID public key, for the phone's Web Push subscription (decision 46).
    Welcome { v: u32, mac: String, known: Known, #[serde(default, skip_serializing_if = "Option::is_none")] push_key: Option<String> },
    /// A batch of events (ULID order), each the stored event. Plain `Value`: serde can't read a
    /// `RawValue` inside an internally tagged enum.
    Events { events: Vec<Value> },
    /// Backlog done; from here on events arrive one by one as they happen.
    Live { cursor: String },
    Event { event: Value },
    Fetch { id: String },
    /// One session's recent rows (its transcript), for a phone that synced light.
    FetchSession { id: String, session: String },
    /// The answer to `FetchSession`: the session's last `SESSION_ROWS` rows, oldest first.
    SessionRows { id: String, session: String, events: Vec<Value> },
    Command { id: String, #[serde(flatten)] command: Command },
    Ack { id: String, ok: bool, #[serde(skip_serializing_if = "Option::is_none")] result: Option<Value>, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> },
    Error { error: String },
}

impl Frame {
    pub fn line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_else(|_| r#"{"t":"error","error":"encode"}"#.into());
        s.push('\n');
        s
    }
}

/// Everything the phone may ask the Mac to do (decision: "Plus start sessions"). Closed set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "args", rename_all = "snake_case")]
pub enum Command {
    SendPrompt { session: String, text: String },
    /// Answer an AskUserQuestion: becomes the same `permission_respond` the desktop sends.
    AnswerQuestion { session: String, request_id: String, input: Value, answers: BTreeMap<String, String> },
    PermissionResponse { session: String, request_id: String, decision: Value },
    Interrupt { session: String },
    StopSession { session: String },
    /// Ids from `Known`, never paths: the Mac maps them back itself.
    StartSession { workspace_id: String, repo_id: String, prompt: String },
    /// The phone's Web Push subscription (`PushSubscription.toJSON()`), so the Mac can notify it.
    RegisterPush { subscription: Value },
}

impl Command {
    pub fn session(&self) -> Option<&str> {
        match self {
            Command::SendPrompt { session, .. }
            | Command::AnswerQuestion { session, .. }
            | Command::PermissionResponse { session, .. }
            | Command::Interrupt { session }
            | Command::StopSession { session } => Some(session),
            Command::StartSession { .. } | Command::RegisterPush { .. } => None,
        }
    }

    /// Shape checks that don't need the Mac's state.
    pub fn check(&self) -> Result<(), String> {
        match self {
            Command::SendPrompt { text, .. } if text.trim().is_empty() => Err("empty message".into()),
            Command::StartSession { prompt, .. } if prompt.trim().is_empty() => Err("empty prompt".into()),
            Command::PermissionResponse { decision, .. } => match decision["behavior"].as_str() {
                Some("allow") | Some("deny") => Ok(()),
                _ => Err("decision.behavior must be allow or deny".into()),
            },
            Command::AnswerQuestion { answers, .. } if answers.is_empty() => Err("no answers".into()),
            Command::RegisterPush { subscription } => {
                let ok = subscription["endpoint"].as_str().is_some_and(|e| e.starts_with("https://"))
                    && subscription["keys"]["p256dh"].is_string()
                    && subscription["keys"]["auth"].is_string();
                if ok { Ok(()) } else { Err("a push subscription needs an https endpoint and its keys".into()) }
            }
            _ => Ok(()),
        }
    }

    /// The `permission_respond` decision an answer turns into (as `ui/src/screens/AskRow.tsx`).
    pub fn answer_decision(input: &Value, answers: &BTreeMap<String, String>) -> Value {
        let mut updated = if input.is_object() { input.clone() } else { serde_json::json!({}) };
        updated["answers"] = serde_json::to_value(answers).unwrap_or_default();
        serde_json::json!({ "behavior": "allow", "updatedInput": updated })
    }
}

/// Where the phone may start sessions: workspaces and repos the Mac already knows.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Known {
    pub workspaces: Vec<KnownWorkspace>,
    pub repos: Vec<KnownRepo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KnownWorkspace {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KnownRepo {
    pub id: String,
    /// The folder's name, for the picker. The full path stays on the Mac.
    pub name: String,
    #[serde(skip)]
    pub path: String,
}

pub fn repo_id(path: &str) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(path.as_bytes())[..8])
}

/// Folds `Known` from the log: workspaces created and not deleted (plus Personal), and every folder
/// a session started in (its repo when it got a worktree) or a workspace pinned, newest first.
pub fn known_from<'a>(events: impl IntoIterator<Item = (&'a str, &'a Value)>) -> Known {
    let mut workspaces: Vec<KnownWorkspace> = vec![KnownWorkspace { id: PERSONAL.into(), name: "Personal".into() }];
    let mut repos: Vec<String> = Vec::new();
    let mut add_repo = |p: &str| {
        if p.is_empty() {
            return;
        }
        repos.retain(|r| r != p);
        repos.push(p.to_owned());
    };
    for (kind, p) in events {
        match kind {
            "ui.workspace_created" => {
                if let (Some(id), Some(name)) = (p["id"].as_str(), p["name"].as_str()) {
                    workspaces.retain(|w| w.id != id);
                    workspaces.push(KnownWorkspace { id: id.into(), name: name.into() });
                }
            }
            "ui.workspace_renamed" => {
                if let (Some(id), Some(name)) = (p["id"].as_str(), p["name"].as_str()) && let Some(w) = workspaces.iter_mut().find(|w| w.id == id) {
                    w.name = name.into();
                }
            }
            "ui.workspace_deleted" => {
                if let Some(id) = p["id"].as_str() {
                    workspaces.retain(|w| w.id != id);
                }
            }
            "ui.workspace_folder_set" => add_repo(p["folder"].as_str().unwrap_or("")),
            // Review/Address sessions run the user's own commands; only blank starts are offered.
            "ui.session_requested" if p["resume"].is_null() && p["kind"].as_str().unwrap_or("blank") == "blank" && p["parent"].is_null() => {
                add_repo(p["repo"].as_str().or(p["cwd"].as_str()).unwrap_or(""))
            }
            _ => {}
        }
    }
    let repos = repos
        .into_iter()
        .rev()
        .take(30)
        .map(|path| KnownRepo { id: repo_id(&path), name: path.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(&path).to_owned(), path })
        .collect();
    Known { workspaces, repos }
}

/// What the phone gets for one stored event: the event as is, `None` for kinds it never renders,
/// or a small `remote.truncated` stand-in it can `Fetch` when the event is too big to stream.
pub fn for_phone(id: &str, kind: &str, session_id: Option<&str>, created_at: i64, json: &str) -> Option<String> {
    if SKIP_KINDS.contains(&kind) {
        return None;
    }
    if json.len() <= MAX_EVENT_BYTES {
        return Some(json.to_owned());
    }
    Some(
        serde_json::json!({ "id": id, "session_id": session_id, "kind": "remote.truncated", "payload": { "kind": kind, "bytes": json.len() }, "anchor": null, "created_at": created_at })
            .to_string(),
    )
}

/// A sliding one-hour window of session starts.
#[derive(Default)]
pub struct StartLimit(std::collections::VecDeque<i64>);

impl StartLimit {
    pub fn take(&mut self, now_ms: i64) -> Result<(), String> {
        while self.0.front().is_some_and(|t| now_ms - t >= 3_600_000) {
            self.0.pop_front();
        }
        if self.0.len() >= STARTS_PER_HOUR {
            return Err(format!("{STARTS_PER_HOUR} sessions were started from the phone in the last hour; start more on the Mac"));
        }
        self.0.push_back(now_ms);
        Ok(())
    }
}

/// Reads one frame (None at the end of the stream). Lines over `MAX_LINE` are an error.
pub async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R) -> Result<Option<Frame>, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    let mut buf = Vec::new();
    let n = (&mut *r).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf).await.map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(None);
    }
    if buf.len() > MAX_LINE {
        return Err("frame too big".into());
    }
    serde_json::from_slice(&buf).map(Some).map_err(|e| format!("bad frame: {e}"))
}

pub async fn write_frame(s: &mut iroh::endpoint::SendStream, f: &Frame) -> Result<(), String> {
    s.write_all(f.line().as_bytes()).await.map_err(|e| e.to_string())
}

pub fn now_ms() -> i64 {
    n0_future::time::SystemTime::now().duration_since(n0_future::time::SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn proof_binds_secret_and_both_keys() {
        let (s, m, p, other) = ([7u8; 16], [1u8; 32], [2u8; 32], [3u8; 32]);
        let proof = pair_proof(&s, &m, &p);
        assert!(proof_ok(&s, &m, &p, &proof));
        assert!(!proof_ok(&[8u8; 16], &m, &p, &proof), "another QR's secret");
        assert!(!proof_ok(&s, &m, &other, &proof), "a MITM's key");
        assert!(!proof_ok(&s, &other, &p, &proof), "another Mac");
        assert!(!proof_ok(&s, &m, &p, "zz"));
        let code = short_code(&s, &m, &p);
        assert_eq!(code.len(), 6);
        assert_ne!(code, short_code(&s, &m, &other));
    }

    #[test]
    fn offer_round_trips_as_text() {
        let key = iroh::SecretKey::generate().public();
        let o = Offer { mac: iroh::EndpointAddr::new(key), secret: data_encoding::HEXLOWER.encode(&new_secret()), expires_at: 42, name: "Mac".into() };
        let t = o.to_text();
        assert!(t.starts_with("cockpit-remote:1:"));
        assert_eq!(Offer::from_text(&t).unwrap(), o);
        assert_eq!(o.secret_bytes().unwrap().len(), 16);
        assert!(Offer::from_text("https://evil").is_err());
    }

    #[test]
    fn commands_are_a_closed_set() {
        let ok: Frame = serde_json::from_value(json!({ "t": "command", "id": "1", "kind": "send_prompt", "args": { "session": "s", "text": "hi" } })).unwrap();
        assert!(matches!(ok, Frame::Command { command: Command::SendPrompt { .. }, .. }));
        for bad in ["run_shell", "read_file", "terminal", "self_build"] {
            assert!(serde_json::from_value::<Frame>(json!({ "t": "command", "id": "1", "kind": bad, "args": { "cmd": "rm -rf /" } })).is_err(), "{bad}");
        }
        let plain_http = Command::RegisterPush { subscription: json!({ "endpoint": "http://evil.example/", "keys": { "p256dh": "B", "auth": "a" } }) };
        assert!(plain_http.check().is_err(), "pushes only go to https push services");
        let weird = Command::PermissionResponse { session: "s".into(), request_id: "r".into(), decision: json!({ "behavior": "always" }) };
        assert!(weird.check().is_err());
        assert!(Command::SendPrompt { session: "s".into(), text: "  ".into() }.check().is_err());
        let d = Command::answer_decision(&json!({ "questions": [] }), &BTreeMap::from([("Which?".to_string(), "A".to_string())]));
        assert_eq!(d, json!({ "behavior": "allow", "updatedInput": { "questions": [], "answers": { "Which?": "A" } } }));
    }

    /// The exact shapes the phone's UI sends (ui/src/mobile/commands.ts and its test).
    #[test]
    fn the_phone_ui_shapes_parse() {
        for v in [
            json!({ "kind": "send_prompt", "args": { "session": "s", "text": "go on" } }),
            json!({ "kind": "permission_response", "args": { "session": "s", "request_id": "r1", "decision": { "behavior": "allow", "updatedInput": { "command": "ls" } } } }),
            json!({ "kind": "answer_question", "args": { "session": "s", "request_id": "r2", "input": { "questions": [] }, "answers": { "Which DB?": "Postgres" } } }),
            json!({ "kind": "interrupt", "args": { "session": "s" } }),
            json!({ "kind": "stop_session", "args": { "session": "s" } }),
            json!({ "kind": "start_session", "args": { "workspace_id": "personal", "repo_id": "a1b2", "prompt": "fix it" } }),
            json!({ "kind": "register_push", "args": { "subscription": { "endpoint": "https://web.push.apple.com/x", "keys": { "p256dh": "B", "auth": "a" } } } }),
        ] {
            let c: Command = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v}: {e}"));
            c.check().unwrap();
        }
    }

    #[test]
    fn known_repos_come_from_the_log_and_never_leak_paths() {
        let evs = [
            ("ui.workspace_created", json!({ "id": "w1", "name": "Work" })),
            ("ui.workspace_created", json!({ "id": "w2", "name": "Gone" })),
            ("ui.workspace_deleted", json!({ "id": "w2" })),
            ("ui.session_requested", json!({ "cwd": "/u/a-worktrees/x", "repo": "/u/a", "kind": "blank", "resume": null })),
            ("ui.session_requested", json!({ "cwd": "/u/b", "kind": "blank", "resume": null })),
            ("ui.session_requested", json!({ "cwd": "/u/c", "kind": "review", "resume": null })),
            ("ui.session_requested", json!({ "cwd": "/u/d", "kind": "blank", "resume": "sdk" })),
            ("ui.session_requested", json!({ "cwd": "/u/a-worktrees/y", "repo": "/u/a", "kind": "blank", "resume": null })),
        ];
        let k = known_from(evs.iter().map(|(k, v)| (*k, v)));
        assert_eq!(k.workspaces.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["personal", "w1"]);
        assert_eq!(k.repos.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), ["/u/a", "/u/b"]);
        assert_eq!(k.repos[0].name, "a");
        assert_eq!(k.repos[0].id, repo_id("/u/a"));
        assert!(!serde_json::to_string(&k).unwrap().contains("/u/"), "paths stay on the Mac");
    }

    #[test]
    fn big_and_desktop_only_events_are_not_streamed() {
        assert_eq!(for_phone("1", "sidecar.commands", None, 0, "{}"), None);
        assert_eq!(for_phone("1", "ui.x", None, 0, r#"{"id":"1"}"#).as_deref(), Some(r#"{"id":"1"}"#));
        let big = "x".repeat(MAX_EVENT_BYTES + 1);
        let v: Value = serde_json::from_str(&for_phone("1", "sidecar.sdk", Some("s"), 5, &big).unwrap()).unwrap();
        assert_eq!(v["kind"], "remote.truncated");
        assert_eq!(v["payload"]["kind"], "sidecar.sdk");
    }

    #[test]
    fn starts_are_capped_per_hour() {
        let mut l = StartLimit::default();
        for i in 0..STARTS_PER_HOUR as i64 {
            l.take(i).unwrap();
        }
        assert!(l.take(10).is_err());
        assert!(l.take(3_600_000).is_ok(), "the oldest start left the window");
    }
}
