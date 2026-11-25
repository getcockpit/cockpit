//! Attach to terminal sessions (MR-219): Claude Code sessions people run in tmux, iTerm or a plain
//! terminal send their permission prompts to Cockpit's needs-you queue.
//!
//! A `PermissionRequest` hook in `~/.claude/settings.json` runs `Cockpit --hook-relay <socket>`
//! (through a small wrapper script). The relay sends the prompt to the core over a 0600 socket and
//! waits. The pane shows its own prompt at the same time, so the first answer wins:
//! - answered in Cockpit: the core logs `hook.answer` and sends the decision; the relay prints it;
//! - answered in the pane: the relay sees the tool's result in the transcript, says so, and exits
//!   with no decision (the core logs `hook.resolved_elsewhere`).
//!
//! Every failure path (no socket, bad input, Cockpit quits, anything unexpected) prints nothing, so
//! Claude Code prompts exactly as it does without the hook. Only a `decision` the core sends after a
//! user's click can make the relay print one.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The wrapper's file name: how our entry in settings.json is recognised.
pub const WRAPPER: &str = "cockpit-hook-relay";
/// Claude Code's hook timeout, in seconds. The pane prompts at once regardless, so this only bounds
/// how long Cockpit can still answer.
const HOOK_TIMEOUT_S: u64 = 3600;
const MAX_INPUT: usize = 1 << 20;

// ---- the relay (runs inside Claude Code's hook, never inside the app) ------------------------------

/// What the relay prints for a message from the core: only a `decision` with allow or deny.
pub fn decision_output(msg: &Value) -> Option<String> {
    if msg["type"] != "decision" {
        return None;
    }
    let behavior = msg["behavior"].as_str().filter(|b| *b == "allow" || *b == "deny")?;
    let mut decision = json!({ "behavior": behavior });
    if behavior == "deny" {
        decision["message"] = json!(msg["message"].as_str().filter(|m| !m.trim().is_empty()).unwrap_or("Denied from Cockpit."));
    }
    Some(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }).to_string())
}

/// The id of the tool call this prompt is about: the last `tool_use` with this name and input in the
/// transcript's tail, so a later result for exactly that call can be told apart from other output.
pub fn tool_use_id(tail: &str, tool: &str, input: &Value) -> Option<String> {
    let mut found = None;
    for line in tail.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        for c in v["message"]["content"].as_array().into_iter().flatten() {
            if c["type"] == "tool_use" && c["name"] == tool && (c["input"] == *input || input.is_null()) {
                found = c["id"].as_str().map(str::to_owned);
            }
        }
    }
    found
}

/// Whether text appended to the transcript shows the prompt was settled in the pane: that call's
/// result (allowed or refused), or any tool result when the call couldn't be identified.
pub fn resolved_in(appended: &str, id: Option<&str>) -> bool {
    match id {
        Some(id) => appended.contains(&format!("\"tool_use_id\":\"{id}\"")),
        None => appended.contains("\"tool_result\""),
    }
}

#[cfg(unix)]
fn read_from(path: &Path, from: u64) -> (u64, String) {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return (from, String::new()) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(from);
    if len <= from || f.seek(SeekFrom::Start(from)).is_err() {
        return (len.max(from), String::new());
    }
    let mut buf = Vec::new();
    let _ = f.take(8 << 20).read_to_end(&mut buf);
    (from + buf.len() as u64, String::from_utf8_lossy(&buf).into_owned())
}

/// The relay itself: the hook's stdin JSON and the socket path in, what to print out (None: nothing,
/// so Claude Code prompts as usual). `max_wait` bounds the whole wait.
#[cfg(unix)]
pub fn relay(stdin: &str, sock: &Path, env: &HashMap<String, String>, max_wait: std::time::Duration) -> Option<String> {
    use std::io::{BufRead, BufReader, Write};
    let input: Value = serde_json::from_str(stdin).ok()?;
    if input["hook_event_name"] != "PermissionRequest" || !input["tool_name"].is_string() {
        return None;
    }
    let mut stream = std::os::unix::net::UnixStream::connect(sock).ok()?;
    let transcript = input["transcript_path"].as_str().map(PathBuf::from);
    // Where the transcript ends now, and which call this prompt is for.
    let (mut offset, id) = match &transcript {
        Some(p) => {
            let len = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let (_, tail) = read_from(p, len.saturating_sub(512 * 1024));
            (len, tool_use_id(&tail, input["tool_name"].as_str().unwrap_or_default(), &input["tool_input"]))
        }
        None => (0, None),
    };
    let pick = |k: &str| env.get(k).cloned().unwrap_or_default();
    let hello = json!({
        "type": "prompt",
        "input": input,
        "tool_use_id": id,
        "pane": pick("TMUX_PANE"),
        "tmux": pick("TMUX"),
        "term": pick("TERM_PROGRAM"),
        "bundle": pick("__CFBundleIdentifier"),
    });
    stream.write_all(format!("{hello}\n").as_bytes()).ok()?;
    stream.set_read_timeout(Some(std::time::Duration::from_millis(500))).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let started = std::time::Instant::now();
    let mut line = String::new();
    loop {
        if started.elapsed() > max_wait {
            return None;
        }
        match reader.read_line(&mut line) {
            Ok(0) => return None, // Cockpit closed the connection (quit, or skipped this prompt)
            Ok(_) => {
                let msg: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
                line.clear();
                if msg["type"] == "skip" {
                    return None;
                }
                if let Some(out) = decision_output(&msg) {
                    return Some(out);
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => return None,
        }
        // Answered in the pane? Then say so and step aside.
        if let Some(p) = &transcript {
            let (next, appended) = read_from(p, offset);
            offset = next;
            if resolved_in(&appended, id.as_deref()) {
                let _ = stream.write_all(b"{\"type\":\"resolved_elsewhere\"}\n");
                return None;
            }
        }
        // Claude Code went away (the session was closed): nothing to answer.
        // SAFETY: getppid has no preconditions.
        if unsafe { libc::getppid() } == 1 {
            return None;
        }
    }
}

/// `Cockpit --hook-relay <socket>`: Claude Code's PermissionRequest hook. Always exits 0.
#[cfg(unix)]
pub fn relay_main(args: &[String]) -> i32 {
    use std::io::{Read, Write};
    let Some(sock) = args.get(2) else { return 0 };
    let mut buf = Vec::new();
    if std::io::stdin().take(MAX_INPUT as u64).read_to_end(&mut buf).is_err() {
        return 0;
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    if let Some(out) = relay(&String::from_utf8_lossy(&buf), Path::new(sock), &env, std::time::Duration::from_secs(HOOK_TIMEOUT_S - 10)) {
        let mut o = std::io::stdout().lock();
        let _ = o.write_all(out.as_bytes()).and_then(|_| o.write_all(b"\n")).and_then(|_| o.flush());
    }
    0
}

#[cfg(not(unix))]
pub fn relay_main(_args: &[String]) -> i32 {
    0
}

// ---- settings.json install / remove ----------------------------------------------------------------

/// Is this hook group ours (its command runs our wrapper)?
fn ours(group: &Value) -> bool {
    group["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains(WRAPPER))))
}

/// Settings with our PermissionRequest hook added (replacing an older copy of ours).
pub fn with_hook(settings: &Value, command: &str) -> Result<Value, String> {
    let mut s = if settings.is_null() { json!({}) } else { settings.clone() };
    let obj = s.as_object_mut().ok_or("settings.json isn't a JSON object")?;
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("settings.json's \"hooks\" isn't an object")?;
    let list = hooks.entry("PermissionRequest").or_insert_with(|| json!([]));
    let list = list.as_array_mut().ok_or("settings.json's PermissionRequest hooks aren't a list")?;
    list.retain(|g| !ours(g));
    list.push(json!({ "matcher": "*", "hooks": [{ "type": "command", "command": command, "timeout": HOOK_TIMEOUT_S }] }));
    Ok(s)
}

/// Settings without our hook; containers we leave empty are dropped.
pub fn without_hook(settings: &Value) -> Value {
    let mut s = settings.clone();
    if let Some(hooks) = s.get_mut("hooks").and_then(Value::as_object_mut) {
        if let Some(list) = hooks.get_mut("PermissionRequest").and_then(Value::as_array_mut) {
            list.retain(|g| !ours(g));
            if list.is_empty() {
                hooks.remove("PermissionRequest");
            }
        }
        if hooks.is_empty() {
            s.as_object_mut().map(|o| o.remove("hooks"));
        }
    }
    s
}

pub fn installed_in(settings: &Value) -> bool {
    settings["hooks"]["PermissionRequest"].as_array().is_some_and(|l| l.iter().any(ours))
}

fn read_settings(path: &Path) -> Result<(Option<Vec<u8>>, Value), String> {
    match std::fs::read(path) {
        Ok(b) if b.iter().all(u8::is_ascii_whitespace) => Ok((Some(b), Value::Null)),
        Ok(b) => serde_json::from_slice(&b).map(|v| (Some(b), v)).map_err(|e| format!("{} isn't valid JSON ({e}); not touching it", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((None, Value::Null)),
        Err(e) => Err(e.to_string()),
    }
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{}.cockpit-bak", path.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json")))
}

/// Adds our hook to `path`, keeping a byte-for-byte backup of what was there.
pub fn install_at(path: &Path, command: &str) -> Result<(), String> {
    let (bytes, settings) = read_settings(path)?;
    if let Some(b) = &bytes
        && !installed_in(&settings)
    {
        std::fs::write(backup_path(path), b).map_err(|e| e.to_string())?;
    }
    let next = with_hook(&settings, command)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_atomic(path, format!("{}\n", serde_json::to_string_pretty(&next).unwrap_or_default()).as_bytes())
}

/// Takes our hook out of `path`. When nothing else changed since install, the original bytes come
/// back exactly; otherwise only our entry is removed.
pub fn remove_at(path: &Path) -> Result<(), String> {
    let (bytes, settings) = read_settings(path)?;
    if bytes.is_none() || !installed_in(&settings) {
        return Ok(());
    }
    let next = without_hook(&settings);
    let bak = backup_path(path);
    let original = std::fs::read(&bak).ok();
    let same = original.as_ref().map(|b| serde_json::from_slice::<Value>(b).ok() == Some(next.clone()) || (b.iter().all(u8::is_ascii_whitespace) && next == json!({}))).unwrap_or(false);
    if same {
        write_atomic(path, original.as_deref().unwrap_or_default())?;
    } else if next == json!({}) && original.is_none() {
        // We created the file: take it away again.
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    } else {
        write_atomic(path, format!("{}\n", serde_json::to_string_pretty(&next).unwrap_or_default()).as_bytes())?;
    }
    let _ = std::fs::remove_file(bak);
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("cockpit-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// `~/.claude/settings.json`: the default config every terminal session reads (decision q-install).
pub fn user_settings() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

// ---- the core side ---------------------------------------------------------------------------------

/// Prompts waiting on an answer: id → the connection to send it on.
#[derive(Default)]
pub struct Hooks {
    waiting: Mutex<HashMap<String, std::sync::mpsc::Sender<Value>>>,
    prompts: Mutex<HashMap<String, Value>>,
}

pub fn socket_path(app: &AppHandle) -> PathBuf {
    crate::selfbuild::data_dir(app).join("hook.sock")
}

fn wrapper_path(app: &AppHandle) -> PathBuf {
    crate::selfbuild::data_dir(app).join("hooks").join(WRAPPER)
}

/// Writes the wrapper Claude Code runs: our current binary in relay mode. A missing app exits 0.
#[cfg(unix)]
fn write_wrapper(app: &AppHandle) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let path = wrapper_path(app);
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"));
    let body = format!(
        "#!/bin/sh\n# Cockpit: relays Claude Code permission prompts to the app's needs-you queue.\n# Prints nothing (the terminal prompts as usual) unless you answer in Cockpit.\n[ -x {exe} ] || exit 0\nexec {exe} --hook-relay {sock}\n",
        exe = q(&exe),
        sock = q(&socket_path(app))
    );
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(path)
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let o = crate::sys::cmd("git").arg("-C").arg(cwd).args(args).output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&o.stdout).trim().to_owned()).filter(|s| !s.is_empty())
}

/// Whether a Claude session id belongs to one of Cockpit's own sessions (they ask in Cockpit already).
fn is_ours(app: &AppHandle, session_id: &str) -> bool {
    !session_id.is_empty()
        && app.try_state::<crate::eventlog::EventLog>().and_then(|log| log.list_kind("sidecar.session_started").ok()).is_some_and(|evs| evs.iter().any(|e| e.payload["sdk_session_id"] == session_id))
}

/// One relay connection: log the prompt, wait for an answer or for the relay to step aside.
#[cfg(unix)]
fn serve_conn(app: AppHandle, stream: std::os::unix::net::UnixStream) {
    use std::io::{BufRead, BufReader, Write};
    let Ok(mut w) = stream.try_clone() else { return };
    let mut lines = BufReader::new(stream).lines();
    let Some(Ok(first)) = lines.next() else { return };
    let Ok(msg) = serde_json::from_str::<Value>(&first) else { return };
    if msg["type"] != "prompt" {
        return;
    }
    let input = &msg["input"];
    if is_ours(&app, input["session_id"].as_str().unwrap_or_default()) {
        let _ = w.write_all(b"{\"type\":\"skip\"}\n");
        return;
    }
    let id = format!("hk_{}", ulid::Ulid::new().to_string().to_lowercase());
    let cwd = input["cwd"].as_str().unwrap_or_default().to_owned();
    let repo = git(&cwd, &["rev-parse", "--show-toplevel"]);
    let branch = git(&cwd, &["branch", "--show-current"]);
    let prompt = json!({
        "id": id,
        "session_id": input["session_id"],
        "tool": input["tool_name"],
        "input": input["tool_input"],
        "suggestions": input["permission_suggestions"],
        "permission_mode": input["permission_mode"],
        "cwd": cwd,
        "repo": repo,
        "branch": branch,
        "pane": msg["pane"],
        "tmux": msg["tmux"].as_str().and_then(|t| t.split(',').next()).unwrap_or_default(),
        "term": msg["term"],
        "bundle": msg["bundle"],
    });
    let h = app.state::<Hooks>();
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    h.waiting.lock().unwrap().insert(id.clone(), tx);
    h.prompts.lock().unwrap().insert(id.clone(), prompt.clone());
    crate::eventlog::record(&app, None, "hook.prompt", &prompt, Some(&id));
    // Answers come from hook_answer on the channel; the relay's own messages on the socket.
    let id2 = id.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        for line in lines {
            let Ok(line) = line else { break };
            if serde_json::from_str::<Value>(&line).is_ok_and(|m| m["type"] == "resolved_elsewhere") {
                finish(&app2, &id2, "hook.resolved_elsewhere");
                return;
            }
        }
        // The relay went away without an answer (its session closed, or it hit its own limit).
        finish(&app2, &id2, "hook.gone");
    });
    if let Ok(decision) = rx.recv() {
        let _ = w.write_all(format!("{decision}\n").as_bytes()).and_then(|_| w.flush());
    }
}

/// Clears a waiting prompt and logs why, once.
fn finish(app: &AppHandle, id: &str, kind: &str) {
    let h = app.state::<Hooks>();
    let was = h.waiting.lock().unwrap().remove(id).is_some();
    h.prompts.lock().unwrap().remove(id);
    if was {
        crate::eventlog::record(app, None, kind, &json!({ "id": id }), Some(id));
    }
}

#[cfg(unix)]
pub fn start(app: &AppHandle) {
    // Keep an installed hook pointing at this binary (dev slots and self-builds move it).
    if user_settings().and_then(|p| read_settings(&p).ok()).is_some_and(|(_, s)| installed_in(&s)) {
        let _ = write_wrapper(app);
    }
    let path = socket_path(app);
    let _ = std::fs::remove_file(&path);
    let old = unsafe { libc::umask(0o177) };
    let listener = std::os::unix::net::UnixListener::bind(&path);
    unsafe { libc::umask(old) };
    let listener = match listener {
        Ok(l) => l,
        Err(e) => return eprintln!("[hooks] can't bind {}: {e}", path.display()),
    };
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if !crate::browser::same_user(&stream) {
                eprintln!("[hooks] refused a connection from another user");
                continue;
            }
            let app = app.clone();
            std::thread::spawn(move || serve_conn(app, stream));
        }
    });
}

#[cfg(not(unix))]
pub fn start(_app: &AppHandle) {}

// ---- commands --------------------------------------------------------------------------------------

/// Allow or deny an outside prompt. Logged first: the relay only ever prints what's logged here.
#[tauri::command]
pub fn hook_answer(app: AppHandle, id: String, behavior: String, message: Option<String>) -> Result<(), String> {
    if behavior != "allow" && behavior != "deny" {
        return Err("behavior must be allow or deny".into());
    }
    let h = app.state::<Hooks>();
    let Some(tx) = h.waiting.lock().unwrap().remove(&id) else {
        return Err("Already answered in the terminal".into());
    };
    h.prompts.lock().unwrap().remove(&id);
    crate::eventlog::record(&app, None, "hook.answer", &json!({ "id": id, "behavior": behavior, "message": message }), Some(&id));
    tx.send(json!({ "type": "decision", "behavior": behavior, "message": message })).map_err(|_| "The terminal session went away".to_owned())
}

/// Brings the prompt's pane forward: tmux window and pane, then the terminal app.
#[tauri::command]
pub fn hook_jump(app: AppHandle, id: String) -> Result<(), String> {
    let p = app.state::<Hooks>().prompts.lock().unwrap().get(&id).cloned()
        .or_else(|| app.try_state::<crate::eventlog::EventLog>().and_then(|l| l.list_kind("hook.prompt").ok()).and_then(|evs| evs.into_iter().rev().find(|e| e.payload["id"] == id.as_str()).map(|e| e.payload)))
        .ok_or("That prompt is gone")?;
    let pane = p["pane"].as_str().unwrap_or_default();
    let sock = p["tmux"].as_str().unwrap_or_default();
    if !pane.is_empty() {
        let tmux = |args: &[&str]| {
            let mut c = crate::sys::cmd("tmux");
            if !sock.is_empty() {
                c.args(["-S", sock]);
            }
            c.args(args).output().map(|o| o.status.success()).unwrap_or(false)
        };
        let _ = tmux(&["switch-client", "-t", pane]);
        let _ = tmux(&["select-window", "-t", pane]);
        let _ = tmux(&["select-pane", "-t", pane]);
    }
    #[cfg(target_os = "macos")]
    {
        let bundle = p["bundle"].as_str().unwrap_or_default();
        let app_name = match p["term"].as_str().unwrap_or_default() {
            "iTerm.app" => "iTerm",
            "Apple_Terminal" => "Terminal",
            "ghostty" => "Ghostty",
            "WezTerm" => "WezTerm",
            _ => "",
        };
        if !bundle.is_empty() {
            let _ = crate::sys::cmd("open").args(["-b", bundle]).status();
        } else if !app_name.is_empty() {
            let _ = crate::sys::cmd("open").args(["-a", app_name]).status();
        }
    }
    crate::eventlog::record(&app, None, "ui.hook_jumped", &json!({ "id": id }), Some(&id));
    Ok(())
}

#[tauri::command]
pub fn hook_status() -> Value {
    let path = user_settings();
    let installed = path.as_deref().and_then(|p| read_settings(p).ok()).is_some_and(|(_, s)| installed_in(&s));
    json!({ "installed": installed, "settings": path.map(|p| p.to_string_lossy().into_owned()), "supported": cfg!(unix) })
}

#[tauri::command]
pub fn hook_install(app: AppHandle) -> Result<Value, String> {
    #[cfg(not(unix))]
    {
        let _ = app;
        return Err("Terminal sessions need macOS or Linux for now".into());
    }
    #[cfg(unix)]
    {
        let path = user_settings().ok_or("No home folder")?;
        let wrapper = write_wrapper(&app)?;
        install_at(&path, &wrapper.to_string_lossy())?;
        crate::eventlog::record(&app, None, "ui.hook_installed", &json!({ "settings": path.to_string_lossy() }), Some("hooks"));
        Ok(hook_status())
    }
}

#[tauri::command]
pub fn hook_remove(app: AppHandle) -> Result<Value, String> {
    let path = user_settings().ok_or("No home folder")?;
    remove_at(&path)?;
    crate::eventlog::record(&app, None, "ui.hook_removed", &json!({ "settings": path.to_string_lossy() }), Some("hooks"));
    Ok(hook_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_decision_with_allow_or_deny_prints_anything() {
        assert_eq!(decision_output(&json!({ "type": "decision", "behavior": "allow" })).unwrap(), r#"{"hookSpecificOutput":{"decision":{"behavior":"allow"},"hookEventName":"PermissionRequest"}}"#);
        let deny = decision_output(&json!({ "type": "decision", "behavior": "deny", "message": "not now" })).unwrap();
        assert!(deny.contains("\"behavior\":\"deny\"") && deny.contains("not now"));
        for m in [json!({ "type": "decision", "behavior": "ALLOW" }), json!({ "type": "decision" }), json!({ "behavior": "allow" }), json!({ "type": "skip" }), json!(null), json!("allow"), json!({ "type": "decision", "behavior": "allowed" })] {
            assert_eq!(decision_output(&m), None, "{m}");
        }
    }

    #[test]
    fn finds_the_call_the_prompt_is_about_and_its_result() {
        let tail = [
            json!({ "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } }),
            json!({ "message": { "content": [{ "type": "tool_use", "id": "t2", "name": "Bash", "input": { "command": "rm x" } }] } }),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        assert_eq!(tool_use_id(&tail, "Bash", &json!({ "command": "rm x" })).as_deref(), Some("t2"));
        assert_eq!(tool_use_id(&tail, "Bash", &json!({ "command": "other" })), None);
        let result = json!({ "message": { "content": [{ "type": "tool_result", "tool_use_id": "t2", "content": "ok" }] } }).to_string();
        assert!(resolved_in(&result, Some("t2")));
        assert!(!resolved_in(&result, Some("t1")));
        assert!(resolved_in(&result, None));
        assert!(!resolved_in("{\"type\":\"assistant\"}", None));
    }

    #[test]
    fn install_and_remove_round_trip_byte_for_byte() {
        let dir = std::env::temp_dir().join(format!("mr-hooks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        // Odd spacing and key order on purpose: remove must give these exact bytes back.
        let original = "{\n  \"model\": \"opus\",\n    \"hooks\": { \"PermissionRequest\": [ { \"matcher\": \"Bash\", \"hooks\": [ { \"type\": \"command\", \"command\": \"/usr/local/bin/mine\" } ] } ],\n \"Stop\": [] },\n  \"env\": {\"A\": \"1\"}\n}\n";
        std::fs::write(&path, original).unwrap();
        install_at(&path, "/x/hooks/cockpit-hook-relay").unwrap();
        let s: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(installed_in(&s));
        assert_eq!(s["hooks"]["PermissionRequest"].as_array().unwrap().len(), 2, "theirs kept, ours added");
        assert_eq!(s["hooks"]["PermissionRequest"][0]["hooks"][0]["command"], "/usr/local/bin/mine");
        assert_eq!(s["model"], "opus");
        // Installing twice keeps one copy of ours.
        install_at(&path, "/y/hooks/cockpit-hook-relay").unwrap();
        let s: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(s["hooks"]["PermissionRequest"].as_array().unwrap().len(), 2);
        remove_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(!backup_path(&path).exists());
        // Changed since install: only our entry goes, their change stays.
        install_at(&path, "/x/hooks/cockpit-hook-relay").unwrap();
        let mut s: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        s["model"] = json!("sonnet");
        std::fs::write(&path, s.to_string()).unwrap();
        remove_at(&path).unwrap();
        let s: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!installed_in(&s));
        assert_eq!(s["model"], "sonnet");
        assert_eq!(s["hooks"]["PermissionRequest"].as_array().unwrap().len(), 1);
        // No settings file: install creates it, remove takes it away.
        std::fs::remove_file(&path).unwrap();
        install_at(&path, "/x/hooks/cockpit-hook-relay").unwrap();
        remove_at(&path).unwrap();
        assert!(!path.exists());
        // Broken JSON is never touched.
        std::fs::write(&path, "{ nope").unwrap();
        assert!(install_at(&path, "/x/hooks/cockpit-hook-relay").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ nope");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    mod relay_paths {
        use super::super::*;
        use std::io::{BufRead, BufReader, Write};
        use std::time::Duration;

        fn input(transcript: &Path) -> String {
            json!({ "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": { "command": "rm -rf build" }, "session_id": "s", "cwd": "/tmp", "transcript_path": transcript }).to_string()
        }

        fn dir(name: &str) -> PathBuf {
            let d = std::env::temp_dir().join(format!("mr-relay-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        /// A fake core that reads the prompt and then does `then` with the connection.
        fn core(sock: &Path, then: impl FnOnce(std::os::unix::net::UnixStream) + Send + 'static) -> std::thread::JoinHandle<Value> {
            let l = std::os::unix::net::UnixListener::bind(sock).unwrap();
            std::thread::spawn(move || {
                let (s, _) = l.accept().unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
                then(s);
                serde_json::from_str(&line).unwrap()
            })
        }

        fn env() -> HashMap<String, String> {
            HashMap::from([("TMUX_PANE".to_owned(), "%3".to_owned())])
        }

        #[test]
        fn no_socket_bad_input_or_wrong_event_print_nothing() {
            let d = dir("none");
            let t = d.join("t.jsonl");
            assert_eq!(relay(&input(&t), &d.join("missing.sock"), &env(), Duration::from_secs(2)), None);
            assert_eq!(relay("not json", &d.join("missing.sock"), &env(), Duration::from_secs(2)), None);
            let sock = d.join("c.sock");
            let _core = core(&sock, |_| panic!("must not connect"));
            assert_eq!(relay(&json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash" }).to_string(), &sock, &env(), Duration::from_secs(2)), None);
        }

        #[test]
        fn cockpit_closing_garbage_or_skip_print_nothing() {
            for reply in [None, Some("garbage\n"), Some("{\"type\":\"skip\"}\n"), Some("{\"type\":\"decision\",\"behavior\":\"yes\"}\n"), Some("{\"behavior\":\"allow\"}\n")] {
                let d = dir("close");
                let sock = d.join("c.sock");
                let c = core(&sock, move |mut s| {
                    if let Some(r) = reply {
                        s.write_all(r.as_bytes()).unwrap();
                    }
                    // then hang up
                });
                assert_eq!(relay(&input(&d.join("t.jsonl")), &sock, &env(), Duration::from_secs(5)), None, "{reply:?}");
                let prompt = c.join().unwrap();
                assert_eq!(prompt["pane"], "%3");
                assert_eq!(prompt["input"]["tool_input"]["command"], "rm -rf build");
            }
        }

        #[test]
        fn the_wait_has_a_limit() {
            let d = dir("limit");
            let sock = d.join("c.sock");
            let _c = core(&sock, |s| { std::thread::sleep(Duration::from_secs(3)); drop(s); });
            let t = std::time::Instant::now();
            assert_eq!(relay(&input(&d.join("t.jsonl")), &sock, &env(), Duration::from_millis(600)), None);
            assert!(t.elapsed() < Duration::from_secs(2));
        }

        #[test]
        fn an_answer_from_cockpit_is_printed() {
            let d = dir("answer");
            let sock = d.join("c.sock");
            let _c = core(&sock, |mut s| {
                s.write_all(b"{\"type\":\"decision\",\"behavior\":\"allow\"}\n").unwrap();
                std::thread::sleep(Duration::from_millis(200));
            });
            let out = relay(&input(&d.join("t.jsonl")), &sock, &env(), Duration::from_secs(5)).unwrap();
            assert!(out.contains("\"behavior\":\"allow\""));
        }

        #[test]
        fn an_answer_in_the_pane_steps_aside() {
            let d = dir("pane");
            let t = d.join("t.jsonl");
            std::fs::write(&t, format!("{}\n", json!({ "message": { "content": [{ "type": "tool_use", "id": "tu9", "name": "Bash", "input": { "command": "rm -rf build" } }] } }))).unwrap();
            let sock = d.join("c.sock");
            let t2 = t.clone();
            let c = core(&sock, move |s| {
                std::thread::sleep(Duration::from_millis(300));
                let mut f = std::fs::OpenOptions::new().append(true).open(&t2).unwrap();
                writeln!(f, "{}", json!({ "message": { "content": [{ "type": "tool_result", "tool_use_id": "tu9", "content": "done" }] } })).unwrap();
                let mut line = String::new();
                BufReader::new(s).read_line(&mut line).unwrap();
                assert!(line.contains("resolved_elsewhere"));
            });
            assert_eq!(relay(&input(&t), &sock, &env(), Duration::from_secs(5)), None);
            assert_eq!(c.join().unwrap()["tool_use_id"], "tu9");
        }
    }
}
