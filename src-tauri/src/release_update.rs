//! Updates from GitHub releases (MR-136). The app reads `latest.json` from the newest release on
//! start and every 6 h. How a newer version gets in depends on what's running:
//! - **Swap:** a release build (`MR_RELEASE=1`, set only by release.yml) downloads the signed
//!   bundle, installs it and restarts; running sessions resume.
//! - **Merge:** a self-built app (its repo has `mine`, decision 25) never takes the release binary:
//!   that would drop your own changes. The release tag is merged into `mine` after a dry-run
//!   preview, then built through the self-build path (health check, fallback, sessions resumed).
//!   When it doesn't fit (conflict, failed build, failed health check) nothing changes and the
//!   banner offers choices: a plan from Claude, keep your build, or take the release with your
//!   changes set aside on `mine-before-<tag>`.
//!
//! The dev loop and self-tests take neither path: main is already ahead of any release.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Where release tags are fetched from for the merge path.
const RELEASES_REPO: &str = "https://github.com/getcockpit/cockpit.git";
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// In the data dir: restart after a swap → resume sessions on ready.
const RESUME_MARKER: &str = "release-resume";
/// In the data dir: a merge build in flight, `{version, build_id}`; read on the next start.
const MERGE_MARKER: &str = "release-merge.json";
/// In the data dir: the version you chose to keep your build over.
const SNOOZED: &str = "release-snoozed";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mode {
    Swap,
    Merge,
    Off,
}

/// Which way this app takes releases, from what it is.
pub fn mode_for(release_build: bool, dev_loop: bool, selftest: bool, has_mine: bool) -> Mode {
    match () {
        _ if dev_loop || selftest => Mode::Off,
        _ if release_build => Mode::Swap,
        _ if has_mine => Mode::Merge,
        _ => Mode::Off,
    }
}

#[derive(Default, Clone)]
struct State {
    /// idle · available (swap) · ready (merges cleanly) · conflicts · installing · building · failed
    phase: &'static str,
    version: String,
    notes: String,
    preview: Option<crate::personal::Preview>,
    /// For phase failed: the stage (fetch, download, merge, build, health) and what it said.
    failure: Option<(String, String)>,
    /// The version this run updated to, once (shown as "Updated").
    updated: Option<String>,
    build_id: Option<String>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn state() -> State {
    STATE.lock().unwrap().clone().unwrap_or_default()
}

fn set(f: impl FnOnce(&mut State)) {
    let mut g = STATE.lock().unwrap();
    f(g.get_or_insert_with(State::default));
}

fn mode() -> Mode {
    let release = option_env!("MR_RELEASE") == Some("1");
    let dev_loop = std::env::var("MR_DEV_LOOP").is_ok_and(|v| v == "1");
    mode_for(release, dev_loop, crate::selftest::enabled(), repo().is_some())
}

/// The app's repo, when it has your `mine` branch.
fn repo() -> Option<PathBuf> {
    crate::changes::app_repo().filter(|r| git(r, &["rev-parse", "--verify", "--quiet", crate::personal::BRANCH]).is_ok())
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::sys::cmd("git").arg("-C").arg(dir).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) }
}

fn record(app: &AppHandle, kind: &str, payload: Value) {
    crate::eventlog::record(app, None, kind, &payload, Some("release"));
}

fn data(app: &AppHandle) -> PathBuf {
    crate::selfbuild::data_dir(app)
}

fn tag(version: &str) -> String {
    format!("v{version}")
}

/// Where a release is fetched to in the app repo: its own namespace, so the public repo's tags
/// never land among (or overwrite) the local repo's own tags.
fn release_ref(version: &str) -> String {
    format!("refs/cockpit-releases/{}", tag(version))
}

/// At startup: settle what the last run started (a swap restart, a merge build), then check now
/// and every 6 h.
pub fn on_start(app: &AppHandle) {
    let dir = data(app);
    if let Ok(s) = std::fs::read_to_string(dir.join(MERGE_MARKER)) {
        let _ = std::fs::remove_file(dir.join(MERGE_MARKER));
        let m: Value = serde_json::from_str(&s).unwrap_or_default();
        let version = m["version"].as_str().unwrap_or_default().to_owned();
        if std::env::var("MR_FALLBACK").is_ok() {
            // The merged build crashed at start and the supervisor brought this one back.
            fail(app, &version, "health", "The merged build didn't start, so your previous build is back.");
        } else if std::env::var("MR_BUILD_ID").ok().as_deref() == m["build_id"].as_str() {
            set(|s| s.updated = Some(version.clone()));
            record(app, "release.installed", json!({ "version": version, "mode": "merge" }));
        }
    }
    if let Ok(v) = std::fs::read_to_string(dir.join(RESUME_MARKER)) {
        if v.trim() == app.package_info().version.to_string() {
            set(|s| s.updated = Some(v.trim().to_owned()));
            record(app, "release.installed", json!({ "version": v.trim(), "mode": "swap" }));
        }
    }
    let m = mode();
    if m == Mode::Off {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        tauri::async_runtime::block_on(check(&app));
        std::thread::sleep(EVERY);
    });
}

/// On sidecar ready after a swap restart: true once, so the caller resumes running sessions.
pub fn take_resume(app: &AppHandle) -> bool {
    std::fs::remove_file(data(app).join(RESUME_MARKER)).is_ok()
}

/// Asks GitHub for a newer release; for the merge path, fetches its tag and previews the merge.
async fn check(app: &AppHandle) {
    // Busy or already decided (failed, conflicts): don't overwrite what the banner shows.
    if matches!(state().phase, "installing" | "building" | "failed" | "conflicts") {
        return;
    }
    let found = match app.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let update = match found {
        Ok(Some(u)) => u,
        Ok(None) => return,
        Err(e) => {
            eprintln!("[release] check failed: {e}");
            return;
        }
    };
    let (version, notes) = (update.version.clone(), update.body.clone().unwrap_or_default());
    if std::fs::read_to_string(data(app).join(SNOOZED)).is_ok_and(|v| v.trim() == version) || state().version == version {
        return;
    }
    let phase = match mode() {
        Mode::Swap => "available",
        Mode::Merge => {
            let Some(repo) = repo() else { return };
            let (t, r) = (tag(&version), release_ref(&version));
            let preview = tauri::async_runtime::spawn_blocking(move || {
                git(&repo, &["fetch", "-q", "--no-tags", RELEASES_REPO, &format!("+refs/tags/{t}:{r}")])?;
                crate::personal::preview_merge(&repo, &r)
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
            match preview {
                // This repo is where releases come from: main is already ahead.
                Ok(None) => return,
                Ok(Some(p)) => {
                    let phase = if p.conflicts.is_empty() { "ready" } else { "conflicts" };
                    record(app, "release.merge_previewed", json!({ "version": version, "yours": p.yours, "brings": p.brings, "conflicts": p.conflicts }));
                    set(|s| s.preview = Some(p));
                    phase
                }
                Err(e) => {
                    set(|s| { s.version = version.clone(); s.notes = notes.clone(); });
                    fail(app, &version, "fetch", &e);
                    return;
                }
            }
        }
        Mode::Off => return,
    };
    record(app, "release.available", json!({ "version": version, "notes": notes }));
    set(|s| { s.phase = phase; s.version = version; s.notes = notes; s.failure = None; });
}

fn fail(app: &AppHandle, version: &str, stage: &str, detail: &str) {
    let tail = &detail[detail.len().saturating_sub(4000)..];
    record(app, "release.failed", json!({ "version": version, "stage": stage, "log": tail }));
    set(|s| { s.phase = "failed"; s.version = version.to_owned(); s.failure = Some((stage.to_owned(), tail.to_owned())); });
}

/// Called by the self-build when a build fails: if it was a release merge, the banner offers choices.
pub fn on_build_failed(app: &AppHandle, build_id: &str, step: &str, log: &str) {
    let s = state();
    if s.phase == "building" && s.build_id.as_deref() == Some(build_id) {
        let _ = std::fs::remove_file(data(app).join(MERGE_MARKER));
        fail(app, &s.version, "build", &format!("Building {step} failed after merging {}:\n\n{log}", tag(&s.version)));
    }
}

#[tauri::command(async)]
pub fn release_status() -> Value {
    let s = state();
    let m = mode();
    json!({
        "mode": match m { Mode::Swap => "swap", Mode::Merge => "merge", Mode::Off => "off" },
        "phase": if s.phase.is_empty() { "idle" } else { s.phase },
        "version": s.version, "notes": s.notes, "preview": s.preview,
        "failure": s.failure.map(|(stage, log)| json!({ "stage": stage, "log": log })),
        "updated": s.updated,
        "mine": repo().and_then(|r| crate::personal::mine_worktree(&r).ok()),
    })
}

/// Check now (the banner's Retry).
#[tauri::command]
pub async fn release_check(app: AppHandle) -> Result<(), String> {
    if state().phase == "failed" {
        set(|s| { s.phase = "idle"; s.failure = None; s.version.clear(); });
    }
    check(&app).await;
    Ok(())
}

/// "Restart to update" (swap) or "Merge into my build" (merge, when it previewed clean).
#[tauri::command]
pub async fn release_install(app: AppHandle) -> Result<(), String> {
    let s = state();
    record(&app, "ui.release_install", json!({ "version": s.version, "phase": s.phase }));
    match s.phase {
        "available" => swap(app, s.version).await,
        "ready" => merge(&app, &s.version),
        _ => Err("nothing to install".into()),
    }
}

async fn swap(app: AppHandle, version: String) -> Result<(), String> {
    set(|s| s.phase = "installing");
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else {
        set(|s| s.phase = "idle");
        return Err("the release is gone".into());
    };
    // Written first: on Windows the installer quits the app itself.
    let marker = data(&app).join(RESUME_MARKER);
    let _ = std::fs::write(&marker, &update.version);
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        let _ = std::fs::remove_file(&marker);
        fail(&app, &version, "download", &e.to_string());
        return Err(e.to_string());
    }
    app.restart();
}

fn merge(app: &AppHandle, version: &str) -> Result<(), String> {
    let repo = repo().ok_or("can't find your app's repo")?;
    if let Err(e) = crate::personal::merge_release(&repo, &release_ref(version), &tag(version)) {
        fail(app, version, "merge", &e);
        return Err(e);
    }
    build(app, &repo, version)
}

fn build(app: &AppHandle, repo: &Path, version: &str) -> Result<(), String> {
    let mine = crate::personal::mine_worktree(repo)?;
    let id = crate::selfbuild::build_and_relaunch(app, mine).inspect_err(|e| fail(app, version, "build", e))?;
    let _ = std::fs::write(data(app).join(MERGE_MARKER), json!({ "version": version, "build_id": id }).to_string());
    set(|s| { s.phase = "building"; s.build_id = Some(id.clone()); });
    Ok(())
}

/// The plan-first prompt for "Ask Claude for a plan" (decided in the MR-136 doc).
fn plan_prompt(version: &str, s: &State) -> String {
    let (t, r) = (tag(version), release_ref(version));
    let what = match (&s.failure, &s.preview) {
        (Some((stage, log)), _) => format!("It failed at the {stage} step:\n\n```\n{}\n```", &log[log.len().saturating_sub(3000)..]),
        (None, Some(p)) => format!("Merging it into `mine` conflicts in: {}.", p.conflicts.join(", ")),
        _ => String::new(),
    };
    format!(
        "Cockpit {version} is released (tag `{t}`, fetched into this repo as `{r}`) and I run a self-built app with my own changes on the `mine` branch. Bringing the release into it doesn't fit. {what}\n\n\
        Plan first, change nothing yet: write a working doc (doc_create) with one block per clash — what my change did, what the release changed, and your proposed resolution — plus a question block for anything that's genuinely my call. Stop for my review.\n\n\
        Once I approve: merge `{r}` into this branch, resolve as agreed, build and test, commit, then call app_update with apply_branch set to this branch."
    )
}

/// One of the choices when a release doesn't fit: plan, keep, take. Logged as a user action.
/// "plan" returns the folder and prompt for a new session (the UI starts it, like other fixes).
#[tauri::command(async)]
pub fn release_choose(app: AppHandle, choice: String) -> Result<Value, String> {
    let s = state();
    let version = s.version.clone();
    record(&app, "ui.release_choice", json!({ "version": version, "choice": choice, "phase": s.phase, "stage": s.failure.as_ref().map(|f| &f.0) }));
    match choice.as_str() {
        "plan" => {
            let repo = repo().ok_or("can't find your app's repo")?;
            let mine = crate::personal::mine_worktree(&repo)?;
            Ok(json!({ "cwd": mine, "prompt": plan_prompt(&version, &s) }))
        }
        "keep" => {
            std::fs::write(data(&app).join(SNOOZED), &version).map_err(|e| e.to_string())?;
            set(|s| *s = State { updated: s.updated.take(), ..State::default() });
            Ok(Value::Null)
        }
        "take" => {
            let repo = repo().ok_or("can't find your app's repo")?;
            let kept = crate::personal::set_aside(&repo, &release_ref(&version), &tag(&version))?;
            record(&app, "release.set_aside", json!({ "version": version, "branch": kept }));
            build(&app, &repo, &version)?;
            Ok(json!({ "kept": kept }))
        }
        _ => Err(format!("unknown choice {choice}")),
    }
}

/// "OK" on the Updated line.
#[tauri::command]
pub fn release_seen() {
    set(|s| s.updated = None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_of_app_takes_releases_its_own_way() {
        // (release build, dev loop, self-test, repo with mine)
        assert_eq!(mode_for(true, false, false, false), Mode::Swap);
        assert_eq!(mode_for(false, false, false, true), Mode::Merge);
        assert_eq!(mode_for(false, true, false, true), Mode::Off);
        assert_eq!(mode_for(true, false, true, false), Mode::Off);
        assert_eq!(mode_for(false, false, false, false), Mode::Off);
    }

    #[test]
    fn the_plan_prompt_asks_for_a_plan_before_any_change() {
        let s = State { preview: Some(crate::personal::Preview { yours: 2, brings: 5, conflicts: vec!["ui/src/a.tsx".into()] }), ..State::default() };
        let p = plan_prompt("0.2.0", &s);
        assert!(p.contains("merge `refs/cockpit-releases/v0.2.0`"), "the tag itself is never fetched into refs/tags");
        assert!(p.contains("`v0.2.0`") && p.contains("ui/src/a.tsx"));
        assert!(p.contains("change nothing yet") && p.contains("doc_create") && p.contains("app_update"));
        let s = State { failure: Some(("build".into(), "error[E0425]".into())), ..State::default() };
        assert!(plan_prompt("0.2.0", &s).contains("error[E0425]"));
    }
}
