//! Several copies of the app at once (MR-99): dev and /Applications share one data folder and one
//! event log. Each copy registers itself under `instances/<origin>` with its pid, picks up the rows
//! the others write and shows them live, and records `app.stopped` for a copy that's gone, so its
//! sessions stop looking alive. A session belongs to the copy that last started or resumed it;
//! the others show it but can't drive it while that copy runs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::eventlog::{Event, EventLog};

pub struct Instances {
    dir: PathBuf,
}

/// How far back each poll re-reads, so rows another process commits late aren't missed.
const WINDOW_MS: i64 = 5_000;

pub fn start(app: &AppHandle, data: &Path) {
    let dir = data.join("instances");
    let _ = std::fs::create_dir_all(&dir);
    let origin = app.state::<EventLog>().origin().to_owned();
    let _ = std::fs::write(dir.join(&origin), std::process::id().to_string());
    app.manage(Instances { dir: dir.clone() });
    // Copies that died since (a crash, a relaunch) leave their sessions looking alive until now.
    reap(app, &dir, &origin);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut seen: HashMap<String, i64> = HashMap::new();
        let mut since = now_ms();
        let mut tick = 0u64;
        loop {
            tick += 1;
            std::thread::sleep(Duration::from_millis(700));
            let now = now_ms();
            for ev in fresh(&app.state::<EventLog>(), since - WINDOW_MS, &mut seen) {
                if let Some(docs) = app.try_state::<crate::docs::Docs>() {
                    docs.apply(&ev);
                }
                let _ = app.emit("mr-event", &ev);
            }
            seen.retain(|_, at| *at >= now - 2 * WINDOW_MS);
            since = now;
            if tick.is_multiple_of(7) {
                reap(&app, &dir, &origin);
            }
        }
    });
}

/// Rows from other copies not handed out yet.
fn fresh(log: &EventLog, since_ms: i64, seen: &mut HashMap<String, i64>) -> Vec<Event> {
    let Ok(rows) = log.foreign_since(since_ms) else { return vec![] };
    rows.into_iter().filter(|e| seen.insert(e.id.clone(), e.created_at).is_none()).collect()
}

/// Records `app.stopped` for every registered copy whose process is gone. Removing its file first
/// means only one copy reports it.
fn reap(app: &AppHandle, dir: &Path, me: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let origin = e.file_name().to_string_lossy().into_owned();
        if origin == me || alive_file(&e.path()) {
            continue;
        }
        if std::fs::remove_file(e.path()).is_ok() {
            crate::eventlog::record(app, None, "app.stopped", &serde_json::json!({ "origin": origin, "reason": "gone" }), None);
        }
    }
}

/// On a clean quit: say so, so the other copies can take its sessions over at once.
pub fn stop(app: &AppHandle) {
    let (Some(inst), Some(log)) = (app.try_state::<Instances>(), app.try_state::<EventLog>()) else { return };
    let origin = log.origin().to_owned();
    if std::fs::remove_file(inst.dir.join(&origin)).is_ok() {
        crate::eventlog::record(app, None, "app.stopped", &serde_json::json!({ "origin": origin, "reason": "quit" }), None);
    }
}

fn alive_file(path: &Path) -> bool {
    std::fs::read_to_string(path).ok().and_then(|s| s.trim().parse::<u32>().ok()).is_some_and(pid_alive)
}

fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
}

/// Another running copy that owns `session` and still has it open, if any: driving it from here
/// too would run one conversation twice.
pub fn owned_elsewhere(app: &AppHandle, session: &str) -> Option<String> {
    let log = app.try_state::<EventLog>()?;
    let inst = app.try_state::<Instances>()?;
    let evs = log.list(Some(session), None, i64::MAX).ok()?;
    let owner = open_owner(&evs, log.origin())?;
    alive_file(&inst.dir.join(&owner)).then_some(owner)
}

/// The other copy that last started this session, unless the session ended since.
fn open_owner(evs: &[Event], me: &str) -> Option<String> {
    let at = evs.iter().rposition(|e| e.kind == "ui.session_requested")?;
    let owner = evs[at].origin.clone()?;
    let ended = evs[at..].iter().any(|e| e.kind == "sidecar.session_ended");
    (owner != me && !ended).then_some(owner)
}

#[tauri::command]
pub fn instance_id(log: tauri::State<'_, EventLog>) -> String {
    log.origin().to_owned()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(kind: &str, origin: Option<&str>) -> Event {
        Event { id: ulid::Ulid::new().to_string(), session_id: Some("s".into()), kind: kind.into(), payload: json!({}), anchor: None, created_at: 0, origin: origin.map(str::to_owned) }
    }

    #[test]
    fn two_copies_on_one_file_see_each_others_rows_once() {
        let dir = std::env::temp_dir().join(format!("mr-instances-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.sqlite");
        let (a, b) = (EventLog::open(&path).unwrap(), EventLog::open(&path).unwrap());
        assert_ne!(a.origin(), b.origin());
        let start = now_ms() - 1;
        a.append(Some("s"), "k", &json!(1), None).unwrap();
        let theirs = b.append(Some("s"), "k", &json!(2), None).unwrap();
        let mut seen = HashMap::new();
        let got = fresh(&a, start, &mut seen);
        assert_eq!(got.iter().map(|e| &e.id).collect::<Vec<_>>(), vec![&theirs.id], "only the other copy's row");
        assert_eq!(got[0].origin.as_deref(), Some(b.origin()));
        assert!(fresh(&a, start, &mut seen).is_empty(), "a re-read window doesn't repeat rows");
    }

    #[test]
    fn a_session_is_someone_elses_only_while_they_have_it_open() {
        assert_eq!(open_owner(&[ev("ui.session_requested", Some("B")), ev("sidecar.sdk", Some("B"))], "A"), Some("B".into()));
        assert_eq!(open_owner(&[ev("ui.session_requested", Some("A"))], "A"), None, "mine");
        assert_eq!(open_owner(&[ev("ui.session_requested", Some("B")), ev("sidecar.session_ended", Some("B"))], "A"), None, "ended there");
        assert_eq!(open_owner(&[ev("ui.session_requested", None)], "A"), None, "rows from before MR-99");
        assert_eq!(open_owner(&[ev("ui.session_requested", Some("B")), ev("sidecar.session_ended", Some("B")), ev("ui.session_requested", Some("C"))], "A"), Some("C".into()), "resumed by a third copy");
    }

    #[test]
    fn a_dead_pid_is_not_alive() {
        let dir = std::env::temp_dir().join(format!("mr-instances-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("me"), std::process::id().to_string()).unwrap();
        std::fs::write(dir.join("gone"), "999999").unwrap();
        assert!(alive_file(&dir.join("me")));
        assert!(!alive_file(&dir.join("gone")));
        assert!(!alive_file(&dir.join("missing")));
    }
}
