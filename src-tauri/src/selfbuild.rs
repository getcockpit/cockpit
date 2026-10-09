//! Self-build (decision 23): the app rebuilds itself from any worktree of its own repo, keeps every
//! build (binary + sidecar + commit), and relaunches into a new one through a small supervisor that
//! falls back to the previous build if the new one doesn't report healthy in time.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Build {
    pub id: String,
    pub sha: String,
    pub branch: String,
    pub worktree: String,
    pub at: i64,
    pub current: bool,
}

pub fn data_dir(app: &AppHandle) -> PathBuf {
    match std::env::var("MR_DATA_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("minority-report")),
    }
}

fn builds_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("builds")
}

fn sh_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    format!(
        "{home}/.cargo/bin:{home}/.bun/bin:{home}/.local/share/mise/shims:{home}/.local/share/mise/installs/bun/latest/bin:{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    )
}

fn git(dir: &Path, args: &[&str]) -> String {
    Command::new("git").arg("-C").arg(dir).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default()
}

/// The ordered build steps; each runs in the worktree with a full PATH.
pub fn steps() -> Vec<(&'static str, &'static str)> {
    vec![
        ("bootstrap", "./scripts/bootstrap.sh"),
        // bun's own runtime, so a stray old `node` on PATH can't break vite.
        ("ui", "cd ui && bun --bun run build"),
        ("app", "cd src-tauri && cargo tauri build --debug --no-bundle"),
    ]
}

fn record(app: &AppHandle, kind: &str, payload: serde_json::Value) {
    crate::eventlog::record(app, None, kind, &payload, Some("selfbuild"));
}

/// Builds the app from `worktree` and stores it as a new build. Runs on a background thread and
/// reports progress as selfbuild.* events.
#[tauri::command]
pub fn selfbuild_start(app: AppHandle, worktree: String) -> Result<String, String> {
    let dir = PathBuf::from(crate::sidecar::expand_home(&app, &worktree));
    if !dir.join("src-tauri/tauri.conf.json").exists() {
        return Err(format!("{} is not a Minority report checkout", dir.display()));
    }
    let id = ulid::Ulid::new().to_string();
    let sha = git(&dir, &["rev-parse", "--short", "HEAD"]);
    let dirty = !git(&dir, &["status", "--porcelain"]).is_empty();
    let branch = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]);
    record(&app, "selfbuild.started", serde_json::json!({ "build_id": id, "worktree": dir, "sha": sha, "dirty": dirty, "branch": branch }));
    let (app2, id2) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        for (name, cmd) in steps() {
            record(&app2, "selfbuild.step", serde_json::json!({ "build_id": id2, "step": name }));
            let out = Command::new("bash").arg("-c").arg(cmd).current_dir(&dir).env("PATH", sh_path()).output();
            let ok = out.as_ref().map(|o| o.status.success()).unwrap_or(false);
            if !ok {
                let tail = out.map(|o| { let e = String::from_utf8_lossy(&o.stderr).into_owned(); e[e.len().saturating_sub(3000)..].to_owned() }).unwrap_or_else(|e| e.to_string());
                record(&app2, "selfbuild.finished", serde_json::json!({ "build_id": id2, "ok": false, "step": name, "log": tail }));
                return;
            }
        }
        let target = dir.join("src-tauri/target/debug");
        let dest = builds_dir(&app2).join(&id2);
        let copy = || -> std::io::Result<()> {
            std::fs::create_dir_all(&dest)?;
            std::fs::copy(target.join("minority-report"), dest.join("minority-report"))?;
            std::fs::copy(target.join("mr-sidecar"), dest.join("mr-sidecar"))?;
            let meta = serde_json::json!({ "id": id2, "sha": format!("{sha}{}", if dirty { "+dirty" } else { "" }), "branch": branch, "worktree": dir, "at": ulid::Ulid::from_string(&id2).map(|u| u.timestamp_ms() as i64).unwrap_or(0) });
            std::fs::write(dest.join("build.json"), meta.to_string())
        };
        match copy() {
            Ok(()) => record(&app2, "selfbuild.finished", serde_json::json!({ "build_id": id2, "ok": true, "seconds": started.elapsed().as_secs() })),
            Err(e) => record(&app2, "selfbuild.finished", serde_json::json!({ "build_id": id2, "ok": false, "step": "store", "log": e.to_string() })),
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn selfbuild_list(app: AppHandle) -> Vec<Build> {
    let current = std::env::var("MR_BUILD_ID").unwrap_or_default();
    let mut out: Vec<Build> = std::fs::read_dir(builds_dir(&app))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path().join("build.json")).ok())
                .filter_map(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .map(|v| Build {
                    id: v["id"].as_str().unwrap_or_default().into(),
                    sha: v["sha"].as_str().unwrap_or_default().into(),
                    branch: v["branch"].as_str().unwrap_or_default().into(),
                    worktree: v["worktree"].as_str().unwrap_or_default().into(),
                    at: v["at"].as_i64().unwrap_or(0),
                    current: v["id"].as_str() == Some(current.as_str()),
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

/// The supervisor: waits for this app to quit, starts the new build, and falls back to the
/// previous binary if the new one hasn't written its health marker in time.
pub fn supervisor_script() -> &'static str {
    r#"#!/bin/bash
# args: <old-pid> <new-bin> <new-build-id> <fallback-bin> <data-dir> <timeout-s>
old="$1"; new="$2"; id="$3"; prev="$4"; data="$5"; wait_s="${6:-90}"
while kill -0 "$old" 2>/dev/null; do sleep 0.2; done
rm -f "$data/healthy-$id"
MR_BUILD_ID="$id" MR_AUTO_RESUME=1 MR_DATA_DIR="$data" "$new" >"$data/builds/$id/run.log" 2>&1 &
pid=$!
for _ in $(seq 1 $((wait_s * 5))); do
  [ -f "$data/healthy-$id" ] && exit 0
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
kill "$pid" 2>/dev/null
echo "$(date) build $id failed its health check; falling back" >>"$data/builds/fallbacks.log"
MR_FALLBACK=1 MR_AUTO_RESUME=1 MR_DATA_DIR="$data" "$prev" >/dev/null 2>&1 &
"#
}

/// Relaunches into a stored build. The current binary is the fallback.
#[tauri::command]
pub fn selfbuild_relaunch(app: AppHandle, build_id: String) -> Result<(), String> {
    // Tauri refuses to start from a path that goes through a symlink (e.g. /var on macOS), so
    // hand the supervisor fully resolved paths.
    let data = data_dir(&app).canonicalize().map_err(|e| e.to_string())?;
    let bin = builds_dir(&app).join(&build_id).join("minority-report");
    let bin = bin.canonicalize().map_err(|_| format!("no build {build_id}"))?;
    let script = data.join("relaunch.sh");
    std::fs::write(&script, supervisor_script()).map_err(|e| e.to_string())?;
    let me = std::env::current_exe().and_then(|p| p.canonicalize()).map_err(|e| e.to_string())?;
    record(&app, "selfbuild.relaunch", serde_json::json!({ "build_id": build_id, "fallback": me }));
    Command::new("bash")
        .arg(&script)
        .args([std::process::id().to_string(), bin.display().to_string(), build_id, me.display().to_string(), data.display().to_string(), "90".into()])
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

/// Called when the sidecar is ready: proves this build works (for the supervisor) and, after a
/// self-build relaunch, resumes the sessions that were running.
pub fn on_ready(app: &AppHandle) {
    if let Ok(id) = std::env::var("MR_BUILD_ID") {
        let _ = std::fs::write(data_dir(app).join(format!("healthy-{id}")), "ok");
    }
    if std::env::var("MR_AUTO_RESUME").is_ok_and(|v| v == "1") {
        resume_interrupted(app);
    }
}

fn resume_interrupted(app: &AppHandle) {
    let log = app.state::<crate::eventlog::EventLog>();
    let Ok(events) = log.list(None, None, i64::MAX) else { return };
    // Last state per session: running if it started and never ended.
    let mut running: std::collections::BTreeMap<String, (Option<String>, String, String)> = Default::default();
    for e in events {
        let Some(sid) = e.session_id.clone() else { continue };
        match e.kind.as_str() {
            "ui.session_requested" => {
                let cwd = e.payload["cwd"].as_str().unwrap_or_default().to_owned();
                let kind = e.payload["kind"].as_str().unwrap_or("blank").to_owned();
                running.entry(sid).or_insert((None, cwd, kind));
            }
            "sidecar.session_started" => {
                if let Some(r) = running.get_mut(&sid) {
                    r.0 = e.payload["sdk_session_id"].as_str().map(str::to_owned);
                }
            }
            "sidecar.session_ended" => {
                running.remove(&sid);
            }
            _ => {}
        }
    }
    for (sid, (sdk, cwd, kind)) in running {
        let Some(sdk) = sdk else { continue };
        let _ = crate::sidecar::session_start(
            app.clone(),
            app.state::<crate::sidecar::Sidecar>(),
            cwd,
            "The app was rebuilt and relaunched. Continue where you left off; say briefly where things stand first.".into(),
            Some(sdk),
            None,
            Some(kind),
            Some(false),
            Some(sid),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_falls_back_when_the_new_build_never_gets_healthy() {
        let dir = std::env::temp_dir().join(format!("mr-sb-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(dir.join("builds/B1")).unwrap();
        let script = dir.join("relaunch.sh");
        std::fs::write(&script, supervisor_script()).unwrap();
        // A "new build" that exits at once, and a fallback that leaves a marker we can see.
        let bad = dir.join("bad.sh");
        std::fs::write(&bad, "#!/bin/bash\nexit 1\n").unwrap();
        let prev = dir.join("prev.sh");
        std::fs::write(&prev, format!("#!/bin/bash\ntouch {}/fallback-ran\n", dir.display())).unwrap();
        for p in [&bad, &prev] {
            Command::new("chmod").arg("+x").arg(p).status().unwrap();
        }
        let st = Command::new("bash").arg(&script).args(["999999", bad.to_str().unwrap(), "B1", prev.to_str().unwrap(), dir.to_str().unwrap(), "3"]).status().unwrap();
        assert!(st.success());
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(dir.join("fallback-ran").exists(), "fallback build should have been launched");
        assert!(std::fs::read_to_string(dir.join("builds/fallbacks.log")).unwrap().contains("B1"));
    }

    #[test]
    fn supervisor_keeps_a_healthy_build() {
        let dir = std::env::temp_dir().join(format!("mr-sb-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(dir.join("builds/B2")).unwrap();
        let script = dir.join("relaunch.sh");
        std::fs::write(&script, supervisor_script()).unwrap();
        let good = dir.join("good.sh");
        std::fs::write(&good, format!("#!/bin/bash\ntouch {}/healthy-$MR_BUILD_ID\nsleep 2\n", dir.display())).unwrap();
        let prev = dir.join("prev.sh");
        std::fs::write(&prev, format!("#!/bin/bash\ntouch {}/fallback-ran\n", dir.display())).unwrap();
        for p in [&good, &prev] {
            Command::new("chmod").arg("+x").arg(p).status().unwrap();
        }
        let st = Command::new("bash").arg(&script).args(["999999", good.to_str().unwrap(), "B2", prev.to_str().unwrap(), dir.to_str().unwrap(), "5"]).status().unwrap();
        assert!(st.success());
        assert!(!dir.join("fallback-ran").exists());
    }
}
