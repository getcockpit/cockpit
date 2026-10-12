//! Self-build (decision 23): the app rebuilds itself from any worktree of its own repo, keeps every
//! build (binary + sidecar + commit), and relaunches into a new one through a small supervisor that
//! falls back to the previous build if the new one doesn't report healthy in time.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

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
        _ => app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("cockpit")),
    }
}

fn builds_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("builds")
}

pub(crate) fn sh_path() -> String {
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
    start(app, dir, false)
}

/// The build itself; with `relaunch`, a passing build is launched straight away (app_update, MR-96).
fn start(app: AppHandle, dir: PathBuf, relaunch: bool) -> Result<String, String> {
    if !dir.join("src-tauri/tauri.conf.json").exists() {
        return Err(format!("{} is not a Cockpit checkout", dir.display()));
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
                UPDATING.store(false, Ordering::SeqCst);
                let tail = out.map(|o| { let e = String::from_utf8_lossy(&o.stderr).into_owned(); e[e.len().saturating_sub(3000)..].to_owned() }).unwrap_or_else(|e| e.to_string());
                record(&app2, "selfbuild.finished", serde_json::json!({ "build_id": id2, "ok": false, "step": name, "log": tail }));
                return;
            }
        }
        let target = dir.join("src-tauri/target/debug");
        let dest = builds_dir(&app2).join(&id2);
        let copy = || -> std::io::Result<()> {
            std::fs::create_dir_all(&dest)?;
            std::fs::copy(target.join("Cockpit"), dest.join("Cockpit"))?;
            std::fs::copy(target.join("mr-sidecar"), dest.join("mr-sidecar"))?;
            std::fs::copy(target.join("mr-dictate"), dest.join("mr-dictate"))?;
            let meta = serde_json::json!({ "id": id2, "sha": format!("{sha}{}", if dirty { "+dirty" } else { "" }), "branch": branch, "worktree": dir, "at": ulid::Ulid::from_string(&id2).map(|u| u.timestamp_ms() as i64).unwrap_or(0) });
            std::fs::write(dest.join("build.json"), meta.to_string())
        };
        match copy() {
            Ok(()) => {
                record(&app2, "selfbuild.finished", serde_json::json!({ "build_id": id2, "ok": true, "seconds": started.elapsed().as_secs() }));
                if relaunch && selfbuild_relaunch(app2.clone(), id2.clone()).is_err() {
                    UPDATING.store(false, Ordering::SeqCst);
                }
            }
            Err(e) => {
                UPDATING.store(false, Ordering::SeqCst);
                record(&app2, "selfbuild.finished", serde_json::json!({ "build_id": id2, "ok": false, "step": "store", "log": e.to_string() }));
            }
        }
    });
    Ok(id)
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
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
/// previous binary if the new one hasn't written its health marker in time. Given an app bundle,
/// it installs the build into it first (so the installed app is the latest build: Dock, Finder,
/// Spotlight) and falls back by restoring the bundle it backed up.
pub fn supervisor_script() -> &'static str {
    r#"#!/bin/bash
# args: <old-pid> <new-bin> <new-build-id> <fallback-bin> <data-dir> <timeout-s> [<app-bundle>]
old="$1"; new="$2"; id="$3"; prev="$4"; data="$5"; wait_s="${6:-90}"; app="${7:-}"
while kill -0 "$old" 2>/dev/null; do sleep 0.2; done
rm -f "$data/healthy-$id"
backup="$data/builds/installed-prev.app"
if [ -n "$app" ] && rm -rf "$backup" && ditto "$app" "$backup"; then
  # rm before cp: a signed binary rewritten in place gets killed by the kernel's signature cache.
  for b in Cockpit mr-sidecar mr-dictate; do
    rm -f "$app/Contents/MacOS/$b" && cp "$(dirname "$new")/$b" "$app/Contents/MacOS/$b"
  done
  # Re-seal the bundle (ad hoc, no hardened runtime: the sidecar needs JIT).
  codesign --force --deep --sign - "$app" >/dev/null 2>&1
  new="$app/Contents/MacOS/Cockpit"
else
  app=""
fi
MR_BUILD_ID="$id" MR_AUTO_RESUME=1 MR_DATA_DIR="$data" "$new" >"$data/builds/$id/run.log" 2>&1 &
pid=$!
for _ in $(seq 1 $((wait_s * 5))); do
  [ -f "$data/healthy-$id" ] && exit 0
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
kill "$pid" 2>/dev/null
echo "$(date) build $id failed its health check; falling back" >>"$data/builds/fallbacks.log"
[ -n "$app" ] && rm -rf "$app" && ditto "$backup" "$app"
MR_FALLBACK=1 MR_AUTO_RESUME=1 MR_DATA_DIR="$data" "$prev" >/dev/null 2>&1 &
"#
}

/// The installed app a relaunch updates in place: the .app the running binary is in or, for a
/// stand-alone self-build (an earlier relaunch before builds were installed), `/Applications/Cockpit.app`.
/// None for the dev loop's slots and in self-tests, which run their binaries as they are.
fn install_target(me: &Path, builds: &Path, installed: &Path) -> Option<PathBuf> {
    if std::env::var("MR_SELFTEST").is_ok_and(|v| !v.is_empty()) {
        return None;
    }
    let bundle = me.parent().filter(|d| d.ends_with("Contents/MacOS")).and_then(Path::parent).and_then(Path::parent);
    match bundle {
        Some(b) if b.extension().is_some_and(|e| e == "app") => Some(b.to_owned()),
        _ if me.starts_with(builds) && installed.join("Contents/MacOS/Cockpit").exists() => Some(installed.to_owned()),
        _ => None,
    }
}

/// Relaunches into a stored build. The current binary is the fallback.
#[tauri::command]
pub fn selfbuild_relaunch(app: AppHandle, build_id: String) -> Result<(), String> {
    // Tauri refuses to start from a path that goes through a symlink (e.g. /var on macOS), so
    // hand the supervisor fully resolved paths.
    let data = data_dir(&app).canonicalize().map_err(|e| e.to_string())?;
    let bin = builds_dir(&app).join(&build_id).join("Cockpit");
    let bin = bin.canonicalize().map_err(|_| format!("no build {build_id}"))?;
    let script = data.join("relaunch.sh");
    std::fs::write(&script, supervisor_script()).map_err(|e| e.to_string())?;
    let me = std::env::current_exe().and_then(|p| p.canonicalize()).map_err(|e| e.to_string())?;
    let builds = builds_dir(&app).canonicalize().unwrap_or_default();
    let install = install_target(&me, &builds, Path::new("/Applications/Cockpit.app"));
    record(&app, "selfbuild.relaunch", serde_json::json!({ "build_id": build_id, "fallback": me, "install": install }));
    let install = install.map(|p| p.display().to_string()).unwrap_or_default();
    Command::new("bash")
        .arg(&script)
        .args([std::process::id().to_string(), bin.display().to_string(), build_id, me.display().to_string(), data.display().to_string(), "90".into(), install])
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

/// `app_update` (MR-96): Claude rebuilds and relaunches the running app at the end of a fix, so the
/// user doesn't have to click Rebuild & relaunch. Same path as Settings → Build my changes: main
/// into `mine` (plus an optional fix branch), build `mine`, then relaunch through the supervisor
/// (health check, fallback, sessions resumed). A failed build never relaunches.
pub const UPDATE_TOOL: &str = "app_update";

/// One update at a time: a second call while one builds is refused.
static UPDATING: AtomicBool = AtomicBool::new(false);

pub fn update_spec() -> serde_json::Value {
    serde_json::json!({
        "name": UPDATE_TOOL,
        "description": "Rebuild the Cockpit app the user is running from their `mine` branch and relaunch into it. Use only when the user asks to update, apply or rebuild the app, after your change is committed. apply_branch: an mr/* branch to apply to `mine` first (main is always brought in). Returns at once; the build takes a few minutes, then the app restarts and this session resumes. If the build fails nothing restarts and the log is in Builds. Tell the user, then end your turn.",
        "params": { "apply_branch": "string" }
    })
}

/// Offered only in sessions working on the app's own repo (its checkout or its worktrees).
pub fn update_available(cwd: &str) -> bool {
    crate::changes::app_repo().is_some_and(|repo| in_app_repo(Path::new(cwd), &repo))
}

fn in_app_repo(cwd: &Path, repo: &Path) -> bool {
    let name = repo.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let worktrees = repo.with_file_name(format!("{name}-worktrees"));
    cwd.starts_with(repo) || cwd.starts_with(&worktrees)
}

pub fn handle_update(app: &AppHandle, args: &serde_json::Value) -> (Vec<(String, serde_json::Value)>, String, bool) {
    let Some(repo) = crate::changes::app_repo() else { return (vec![], "Not updated: this app has no repo to build from.".into(), true) };
    if UPDATING.swap(true, Ordering::SeqCst) {
        return (vec![], "Not updated: an update is already building. Its progress is in Builds.".into(), true);
    }
    let branch = args["apply_branch"].as_str().map(str::trim).filter(|b| !b.is_empty());
    let prepared = match branch {
        Some(b) => crate::personal::apply(&repo, b),
        None => crate::personal::sync_with_main(&repo),
    }
    .and_then(|_| crate::personal::mine_worktree(&repo));
    let started = prepared.and_then(|mine| start(app.clone(), mine, true));
    match started {
        Ok(id) => (
            vec![("selfbuild.update_requested".into(), serde_json::json!({ "build_id": id, "apply_branch": branch }))],
            format!("Building `mine` (build {id}). When it passes, the app relaunches into it and this session resumes; if it fails, nothing restarts and the log is in Builds. Tell the user, then end your turn."),
            false,
        ),
        Err(e) => {
            UPDATING.store(false, Ordering::SeqCst);
            (vec![], format!("Not updated: {e}"), true)
        }
    }
}

/// Called when the sidecar is ready: proves this build works (for the supervisor) and, after a
/// self-build relaunch, resumes the sessions that were running.
pub fn on_ready(app: &AppHandle) {
    if let Ok(id) = std::env::var("MR_BUILD_ID") {
        let _ = std::fs::write(data_dir(app).join(format!("healthy-{id}")), "ok");
    }
    // The dev loop's crash guard (MR-70): ready means this slot starts fine and is safe to fall back to.
    if let Ok(f) = std::env::var("MR_HEALTH_FILE") {
        if !f.is_empty() {
            let _ = std::fs::write(f, "ok");
        }
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
            Some(sid), None, None
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_update_is_offered_only_on_the_apps_own_repo_and_worktrees() {
        let repo = Path::new("/Users/u/minority-report");
        assert!(in_app_repo(Path::new("/Users/u/minority-report"), repo));
        assert!(in_app_repo(Path::new("/Users/u/minority-report-worktrees/fix-tile-ab12"), repo));
        assert!(!in_app_repo(Path::new("/Users/u/minority-report-old"), repo));
        assert!(!in_app_repo(Path::new("/Users/u/other-project"), repo));
    }

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
        // The fallback is launched detached: wait for it (generously, so a busy machine can't flake this).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !dir.join("fallback-ran").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(dir.join("fallback-ran").exists(), "fallback build should have been launched");
        assert!(std::fs::read_to_string(dir.join("builds/fallbacks.log")).unwrap().contains("B1"));
    }

    #[test]
    fn relaunch_installs_into_the_app_bundle() {
        let dir = std::env::temp_dir().join(format!("mr-it-{}", ulid::Ulid::new()));
        let (builds, installed) = (dir.join("builds"), dir.join("Cockpit.app"));
        let in_bundle = Path::new("/Applications/Cockpit.app/Contents/MacOS/Cockpit");
        assert_eq!(install_target(in_bundle, &builds, &installed), Some(PathBuf::from("/Applications/Cockpit.app")));
        // A stand-alone self-build goes into the installed app only if there is one.
        let standalone = builds.join("B1/Cockpit");
        assert_eq!(install_target(&standalone, &builds, &installed), None);
        std::fs::create_dir_all(installed.join("Contents/MacOS")).unwrap();
        std::fs::write(installed.join("Contents/MacOS/Cockpit"), "").unwrap();
        assert_eq!(install_target(&standalone, &builds, &installed), Some(installed.clone()));
        // The dev loop's slots run as they are.
        assert_eq!(install_target(Path::new("/r/src-tauri/target/slot-a/debug/Cockpit"), &builds, &installed), None);
    }

    #[test]
    fn supervisor_installs_the_build_and_restores_the_app_on_fallback() {
        let dir = std::env::temp_dir().join(format!("mr-sb-{}", ulid::Ulid::new()));
        let app = dir.join("Cockpit.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::create_dir_all(dir.join("builds/B3")).unwrap();
        let script = dir.join("relaunch.sh");
        std::fs::write(&script, supervisor_script()).unwrap();
        let sh = |p: PathBuf, body: &str| {
            std::fs::write(&p, format!("#!/bin/bash\n{body}\n")).unwrap();
            Command::new("chmod").arg("+x").arg(&p).status().unwrap();
        };
        sh(app.join("Contents/MacOS/Cockpit"), "");
        sh(dir.join("builds/B3/Cockpit"), &format!("touch {}/healthy-$MR_BUILD_ID; sleep 2", dir.display()));
        for b in ["mr-sidecar", "mr-dictate"] {
            sh(app.join("Contents/MacOS").join(b), "");
            sh(dir.join("builds/B3").join(b), "");
        }
        let new = dir.join("builds/B3/Cockpit");
        let prev = app.join("Contents/MacOS/Cockpit");
        let run = |timeout: &str| {
            let st = Command::new("bash").arg(&script).args(["999999", new.to_str().unwrap(), "B3", prev.to_str().unwrap(), dir.to_str().unwrap(), timeout, app.to_str().unwrap()]).status().unwrap();
            assert!(st.success());
        };
        run("5");
        let installed = std::fs::read_to_string(app.join("Contents/MacOS/Cockpit")).unwrap();
        assert!(installed.contains("healthy-"), "the build should now be the app's binary");
        assert!(dir.join("builds/installed-prev.app/Contents/MacOS/Cockpit").exists());

        // A build that never gets healthy: the app is restored from its backup.
        sh(dir.join("builds/B3/Cockpit"), "exit 1");
        std::fs::remove_file(dir.join("healthy-B3")).ok();
        run("3");
        // The backup held the healthy build from the first run, so that's what comes back.
        assert!(std::fs::read_to_string(app.join("Contents/MacOS/Cockpit")).unwrap().contains("healthy-"));
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
