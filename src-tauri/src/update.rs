//! One-click Update (decision 27). The running app knows the commit it was built from; when main
//! has app changes past it (Rust core, sidecar, dictate helper), the UI offers Update. Update builds
//! the other dev slot in the background (scripts/dev.sh runs target/slot-a or slot-b, so the
//! running sidecar binary is never overwritten), then exits asking dev.sh for that slot: the app is
//! back within seconds and resumes running sessions. A failed build leaves the running app alone.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::AppHandle;

/// Paths whose changes need the app rebuilt. UI changes don't: Vite serves them live.
const APP_PATHS: &[&str] = &["src-tauri", "sidecar", "dictate", "scripts/build-sidecar.sh", "scripts/bootstrap.sh"];

static RUNNING: OnceLock<String> = OnceLock::new();
static BUILD: Mutex<Option<Built>> = Mutex::new(None);

#[derive(Clone)]
struct Built {
    slot: String,
    sha: String,
    subjects: Vec<String>,
    done: bool,
}

fn git(dir: &Path, args: &[&str]) -> String {
    Command::new("git").arg("-C").arg(dir).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default()
}

fn repo() -> Option<PathBuf> {
    crate::changes::app_repo()
}

fn dev_loop() -> bool {
    std::env::var("MR_DEV_LOOP").is_ok_and(|v| v == "1")
}

fn other_slot() -> String {
    if std::env::var("MR_DEV_SLOT").as_deref() == Ok("b") { "a".into() } else { "b".into() }
}

/// Commits on `head` past `running` that touch the app (newest first): "sha\tsubject" lines.
pub fn pending(dir: &Path, running: &str, head: &str) -> Vec<(String, String)> {
    if running.is_empty() || running == head {
        return vec![];
    }
    let range = format!("{running}..{head}");
    let mut args = vec!["log", "--no-merges", "--format=%h%x09%s", range.as_str(), "--"];
    args.extend_from_slice(APP_PATHS);
    git(dir, &args).lines().filter_map(|l| l.split_once('\t').map(|(a, b)| (a.to_owned(), b.to_owned()))).collect()
}

/// Called once at startup: remember what this app was built from and say so in the log.
pub fn on_start(app: &AppHandle) {
    let sha = repo().map(|r| git(&r, &["rev-parse", "HEAD"])).unwrap_or_default();
    let _ = RUNNING.set(sha.clone());
    crate::eventlog::record(app, None, "app.started", &json!({ "sha": sha, "slot": std::env::var("MR_DEV_SLOT").ok(), "dev_loop": dev_loop() }), None);
    // Started by the crash guard after a newer build crashed at start (MR-70): say so, with the log.
    if let Some(from) = std::env::var("MR_RECOVERED").ok().filter(|s| !s.is_empty()) {
        let log = std::env::var("MR_CRASH_LOG").ok().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
        crate::eventlog::record(app, None, "app.recovered", &json!({ "crashed_slot": from, "slot": std::env::var("MR_DEV_SLOT").ok(), "sha": sha, "log": last_crash(&log) }), None);
    }
}

/// The newest entry of the crash log (it's appended to, one "=== …" header per crash).
pub fn last_crash(log: &str) -> String {
    log.rfind("=== ").map(|i| log[i..].trim().to_owned()).unwrap_or_default()
}

#[tauri::command(async)]
pub fn update_status() -> Value {
    let Some(dir) = repo() else { return json!({ "mode": "unavailable", "pending": [] }) };
    let running = RUNNING.get().cloned().unwrap_or_default();
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let list: Vec<Value> = pending(&dir, &running, &head).into_iter().map(|(sha, subject)| json!({ "sha": sha, "subject": subject })).collect();
    let b = BUILD.lock().unwrap().clone();
    json!({
        "mode": if dev_loop() { "ready" } else { "manual" },
        "running": running, "head": head, "pending": list,
        "build": b.map(|b| json!({ "sha": b.sha, "done": b.done })),
    })
}

/// Builds main into the other slot in the background; progress arrives as update.* events.
#[tauri::command]
pub fn update_start(app: AppHandle) -> Result<(), String> {
    if !dev_loop() {
        return Err("Updates need the app started with ./scripts/dev.sh".into());
    }
    let dir = repo().ok_or("can't find the app's repo")?;
    {
        let mut b = BUILD.lock().unwrap();
        if b.as_ref().is_some_and(|b| !b.done) {
            return Ok(()); // already building
        }
        let running = RUNNING.get().cloned().unwrap_or_default();
        let head = git(&dir, &["rev-parse", "HEAD"]);
        let subjects = pending(&dir, &running, &head).into_iter().map(|(_, s)| s).collect();
        *b = Some(Built { slot: other_slot(), sha: head, subjects, done: false });
    }
    let built = BUILD.lock().unwrap().clone().unwrap();
    crate::eventlog::record(&app, None, "update.started", &json!({ "to": built.sha, "subjects": built.subjects }), Some("update"));
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let steps = [
            ("sidecar", "./scripts/bootstrap.sh".to_owned()),
            ("app", format!("cd src-tauri && CARGO_TARGET_DIR=target/slot-{} cargo build", built.slot)),
        ];
        for (name, cmd) in steps {
            crate::eventlog::record(&app, None, "update.step", &json!({ "step": name }), Some("update"));
            let out = Command::new("bash").arg("-c").arg(&cmd).current_dir(&dir).env("PATH", crate::selfbuild::sh_path()).env_remove("CARGO_TARGET_DIR").output();
            if !out.as_ref().is_ok_and(|o| o.status.success()) {
                let log = out.map(|o| { let e = String::from_utf8_lossy(&o.stderr).into_owned(); e[e.len().saturating_sub(4000)..].to_owned() }).unwrap_or_else(|e| e.to_string());
                *BUILD.lock().unwrap() = None;
                crate::eventlog::record(&app, None, "update.finished", &json!({ "ok": false, "step": name, "log": log }), Some("update"));
                return;
            }
        }
        if let Some(b) = BUILD.lock().unwrap().as_mut() {
            b.done = true;
        }
        crate::eventlog::record(&app, None, "update.finished", &json!({ "ok": true, "seconds": started.elapsed().as_secs(), "to": built.sha }), Some("update"));
    });
    Ok(())
}

/// For the self-test: Some(done) while an update is building or built, None when none (or it failed).
pub fn built() -> Option<bool> {
    BUILD.lock().unwrap().as_ref().map(|b| b.done)
}

/// Switches to the freshly built slot: dev.sh relaunches it and running sessions resume.
#[tauri::command]
pub fn update_restart(app: AppHandle) -> Result<(), String> {
    let b = BUILD.lock().unwrap().clone().filter(|b| b.done).ok_or("nothing built yet")?;
    let dir = repo().ok_or("can't find the app's repo")?;
    std::fs::write(dir.join("src-tauri/target/mr-update"), &b.slot).map_err(|e| e.to_string())?;
    crate::eventlog::record(&app, None, "update.restarting", &json!({ "from": RUNNING.get(), "to": b.sha, "subjects": b.subjects }), Some("update"));
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn sh(dir: &Path, cmd: &str) {
        assert!(Command::new("bash").arg("-c").arg(cmd).current_dir(dir).status().unwrap().success(), "{cmd}");
    }

    #[cfg(unix)] // on Windows `bash` can resolve to the WSL stub
    #[test]
    fn only_app_changes_count_as_pending() {
        let dir = std::env::temp_dir().join(format!("mr-up-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = "git -c user.email=t@t -c user.name=t commit -q";
        sh(&dir, &format!("git init -q -b main && mkdir -p src-tauri/src ui sidecar && touch ui/a src-tauri/src/a && git add . && {c} -m base"));
        let base = git(&dir, &["rev-parse", "HEAD"]);
        sh(&dir, &format!("echo 1 > ui/a && git add . && {c} -m 'UI only'"));
        sh(&dir, &format!("echo 1 > src-tauri/src/a && git add . && {c} -m 'Core change'"));
        sh(&dir, &format!("echo 1 > sidecar/b && git add . && {c} -m 'Sidecar change'"));
        let head = git(&dir, &["rev-parse", "HEAD"]);
        let subjects: Vec<String> = pending(&dir, &base, &head).into_iter().map(|(_, s)| s).collect();
        assert_eq!(subjects, vec!["Sidecar change", "Core change"]);
        assert!(pending(&dir, &head, &head).is_empty());
        assert!(pending(&dir, "", &head).is_empty());
    }

    #[test]
    fn the_newest_crash_is_picked_from_the_log() {
        let log = "=== 1 crash at start · slot b\nold\n=== 2 crash at start · slot a · exit 101\nthread 'main' panicked\n";
        assert_eq!(last_crash(log), "=== 2 crash at start · slot a · exit 101\nthread 'main' panicked");
        assert_eq!(last_crash(""), "");
    }
}
