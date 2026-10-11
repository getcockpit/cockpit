//! Run a command Claude suggested (MR-85): the Run button next to a shell command in a reply.
//! It runs in the session's folder under the user's login shell, its output goes to a file under
//! <data>/runs/, and the session's side panel lists it with Claude's background tasks.
//! `ui.run_started` is logged here, in the command that performs it; `run.finished` when it exits.

use std::collections::{HashMap, HashSet};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct Runs {
    pids: Mutex<HashMap<String, u32>>, // run id → process group of what's still running
    stopped: Mutex<HashSet<String>>,   // runs you stopped, so their exit reads "stopped", not "failed"
}

fn runs_dir(app: &AppHandle) -> PathBuf {
    crate::selfbuild::data_dir(app).join("runs")
}

/// Run ids are ULIDs; anything else can't name a file under runs/.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// How a run ended, from its exit status: completed, failed (code) or stopped (by you or a signal).
fn outcome(code: Option<i32>, stopped_by_you: bool) -> &'static str {
    match code {
        _ if stopped_by_you => "stopped",
        Some(0) => "completed",
        Some(_) => "failed",
        None => "stopped",
    }
}

// Off the main thread: it spawns and does I/O (MR-57).
#[tauri::command(async)]
pub fn run_command(app: AppHandle, runs: State<'_, Runs>, session: String, cwd: String, command: String) -> Result<String, String> {
    let command = command.trim().to_owned();
    if command.is_empty() {
        return Err("nothing to run".into());
    }
    let cwd = crate::sidecar::expand_home(&app, &cwd);
    if !Path::new(&cwd).is_dir() {
        return Err(format!("the session's folder is gone: {cwd}"));
    }
    let id = ulid::Ulid::new().to_string();
    let dir = runs_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let output = dir.join(format!("{id}.output"));
    let mut child = spawn(&cwd, &command, &output)?;
    let pid = child.id();
    runs.pids.lock().unwrap().insert(id.clone(), pid);
    crate::eventlog::record(&app, Some(&session), "ui.run_started", &json!({ "run_id": id, "command": command, "cwd": cwd, "output": output.to_string_lossy() }), None);
    let (app2, id2) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        let status = child.wait().ok();
        let runs = app2.state::<Runs>();
        runs.pids.lock().unwrap().remove(&id2);
        let by_you = runs.stopped.lock().unwrap().remove(&id2);
        let code = status.and_then(|s| s.code());
        crate::eventlog::record(&app2, Some(&session), "run.finished", &json!({ "run_id": id2, "code": code, "status": outcome(code, by_you) }), None);
    });
    Ok(id)
}

#[tauri::command]
pub fn run_stop(app: AppHandle, runs: State<'_, Runs>, session: String, run_id: String) -> Result<(), String> {
    let Some(pid) = runs.pids.lock().unwrap().get(&run_id).copied() else {
        return Ok(()); // already finished
    };
    runs.stopped.lock().unwrap().insert(run_id.clone());
    crate::eventlog::record(&app, Some(&session), "ui.run_stopped", &json!({ "run_id": run_id }), None);
    stop(pid)
}

/// Starts `command` in `cwd` with stdout and stderr going to `output`, in its own process group.
fn spawn(cwd: &str, command: &str, output: &Path) -> Result<std::process::Child, String> {
    let file = std::fs::File::create(output).map_err(|e| e.to_string())?;
    let err = file.try_clone().map_err(|e| e.to_string())?;
    // A login shell: the app's GUI PATH is minimal, the user's own commands need their PATH.
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    Command::new(&shell)
        .args(["-lc", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(file)
        .stderr(err)
        .process_group(0) // its own group, so Stop reaches whatever it started
        .spawn()
        .map_err(|e| format!("couldn't start {shell}: {e}"))
}

/// Ends the run's whole process group, children included.
fn stop(pid: u32) -> Result<(), String> {
    Command::new("/bin/kill").args(["-TERM", &format!("-{pid}")]).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// The last 16 KB a run wrote.
// Off the main thread: it does I/O (MR-57).
#[tauri::command(async)]
pub fn run_output(app: AppHandle, run_id: String) -> Result<String, String> {
    if !valid_id(&run_id) {
        return Err("bad run id".into());
    }
    crate::changes::tail_file(&runs_dir(&app).join(format!("{run_id}.output")), 16 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ulid_like_ids_name_an_output_file() {
        assert!(valid_id("01JABCDEF0123456789XYZ"));
        assert!(!valid_id(""));
        assert!(!valid_id("../events"));
        assert!(!valid_id("a/b"));
    }

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("mr-runs-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_run_writes_stdout_and_stderr_to_its_file_in_the_session_folder() {
        let d = temp();
        let out = d.join("r.output");
        let code = spawn(d.to_str().unwrap(), "pwd; echo to-err >&2; exit 3", &out).unwrap().wait().unwrap().code();
        let text = std::fs::read_to_string(&out).unwrap();
        assert_eq!(code, Some(3));
        assert!(text.contains("mr-runs-"), "ran in the folder: {text}");
        assert!(text.contains("to-err"));
        assert_eq!(crate::changes::tail_file(&out, 7).unwrap(), "to-err\n");
    }

    #[test]
    fn stop_ends_the_run_and_what_it_started() {
        let d = temp();
        let mut child = spawn(d.to_str().unwrap(), "sleep 30 & sleep 30", &d.join("r.output")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let t = std::time::Instant::now();
        stop(child.id()).unwrap();
        let status = child.wait().unwrap();
        assert!(t.elapsed().as_secs() < 5);
        assert_eq!(outcome(status.code(), true), "stopped");
        let left = Command::new("/usr/bin/pgrep").args(["-g", &child.id().to_string()]).output().unwrap();
        assert!(left.stdout.is_empty(), "background child survived");
    }

    #[test]
    fn exit_status_becomes_an_outcome() {
        assert_eq!(outcome(Some(0), false), "completed");
        assert_eq!(outcome(Some(2), false), "failed");
        assert_eq!(outcome(None, false), "stopped");
        assert_eq!(outcome(Some(143), true), "stopped");
    }
}
