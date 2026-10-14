//! Your own changes to the app (decision 25). Everything the app changes in itself — god-mode fixes,
//! self-improvement sessions — is collected on a local branch `mine` (never pushed), checked out in
//! `<repo>-worktrees/mine`. Settings shows that history, applies pending fix branches, reverts
//! single changes, and builds/relaunches from it (rollback = launch an earlier build).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

pub const BRANCH: &str = "mine";

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) }
}

/// The checkout of `mine`, created from the repo's main branch on first use.
pub fn mine_worktree(repo: &Path) -> Result<PathBuf, String> {
    let name = repo.file_name().and_then(|n| n.to_str()).unwrap_or("repo");
    let path = repo.parent().ok_or("repo has no parent")?.join(format!("{name}-worktrees")).join(BRANCH);
    if path.join(".git").exists() {
        return Ok(path);
    }
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let exists = git(repo, &["rev-parse", "--verify", "--quiet", BRANCH]).is_ok();
    if exists {
        git(repo, &["worktree", "add", path.to_str().ok_or("bad path")?, BRANCH])?;
    } else {
        let base = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "main".into());
        git(repo, &["worktree", "add", "-b", BRANCH, path.to_str().ok_or("bad path")?, &base])?;
    }
    Ok(path)
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Change {
    pub sha: String,
    pub subject: String,
    pub at: i64,
    pub mine_only: bool, // not on the main branch: one of your own changes
}

#[derive(Debug, Serialize)]
pub struct History {
    pub worktree: String,
    pub changes: Vec<Change>,
    /// mr/* branches (e.g. god-mode fix sessions) with commits not yet in `mine`.
    pub pending: Vec<Pending>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Pending {
    pub branch: String,
    pub commits: u32,
    pub subject: String,
}

pub fn history(repo: &Path) -> Result<History, String> {
    let wt = mine_worktree(repo)?;
    let main = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "main".into());
    let only_mine: std::collections::HashSet<String> = git(&wt, &["rev-list", &format!("{main}..{BRANCH}")]).unwrap_or_default().lines().map(str::to_owned).collect();
    let changes = git(&wt, &["log", BRANCH, "-n", "60", "--format=%H%x09%ct%x09%s"])?
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            let (sha, at, subject) = (p.next()?, p.next()?, p.next()?);
            Some(Change { sha: sha.into(), subject: subject.into(), at: at.parse::<i64>().unwrap_or(0) * 1000, mine_only: only_mine.contains(sha) })
        })
        .collect();
    let mut pending = vec![];
    for b in git(repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads/mr/"])?.lines().filter(|l| !l.is_empty()) {
        let n: u32 = git(repo, &["rev-list", "--count", &format!("{BRANCH}..{b}")]).unwrap_or_default().parse().unwrap_or(0);
        if n > 0 {
            let subject = git(repo, &["log", "-1", "--format=%s", b]).unwrap_or_default();
            pending.push(Pending { branch: b.into(), commits: n, subject });
        }
    }
    Ok(History { worktree: wt.display().to_string(), changes, pending })
}

/// Brings the app's main line into `mine`, so your app gets new work and your own changes stay on
/// top. Nothing changes on a conflict.
pub fn sync_with_main(repo: &Path) -> Result<String, String> {
    let wt = mine_worktree(repo)?;
    let main = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "main".into());
    if main == BRANCH {
        return Ok(String::new());
    }
    git(&wt, &["merge", "--no-edit", &main]).map_err(|e| {
        let _ = git(&wt, &["merge", "--abort"]);
        format!("merge conflict with {main}, nothing changed: {e}")
    })
}

pub fn apply(repo: &Path, branch: &str) -> Result<String, String> {
    if !branch.starts_with("mr/") {
        return Err("only mr/* branches can be applied".into());
    }
    sync_with_main(repo)?;
    let wt = mine_worktree(repo)?;
    git(&wt, &["merge", "--no-ff", "--no-edit", branch]).map_err(|e| {
        let _ = git(&wt, &["merge", "--abort"]);
        format!("merge conflict, nothing applied: {e}")
    })
}

/// What merging a release tag into `mine` would do, worked out without touching the worktree.
#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct Preview {
    /// Your own commits the release doesn't have.
    pub yours: usize,
    /// Commits the release brings.
    pub brings: usize,
    /// Files that would conflict; empty means it merges cleanly.
    pub conflicts: Vec<String>,
}

/// Previews merging `tag` into `mine`. None when they share no history: this repo is where
/// releases come from (the public repo is a scrubbed export of it), so there's nothing to merge.
pub fn preview_merge(repo: &Path, tag: &str) -> Result<Option<Preview>, String> {
    if git(repo, &["merge-base", BRANCH, tag]).is_err() {
        return Ok(None);
    }
    let count = |range: String| git(repo, &["rev-list", "--count", "--no-merges", &range]).ok().and_then(|n| n.parse().ok()).unwrap_or(0);
    let (yours, brings) = (count(format!("{tag}..{BRANCH}")), count(format!("{BRANCH}..{tag}")));
    // Exit 1 with the conflicted files listed after the tree id; exit 0 when clean.
    let out = Command::new("git").arg("-C").arg(repo).args(["merge-tree", "--write-tree", "--name-only", "--no-messages", BRANCH, tag]).output().map_err(|e| format!("git: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let conflicts = match out.status.code() {
        Some(0) => vec![],
        Some(1) => text.lines().skip(1).take_while(|l| !l.is_empty()).map(str::to_owned).collect(),
        _ => return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()),
    };
    Ok(Some(Preview { yours, brings, conflicts }))
}

/// Merges a release tag into `mine`. Nothing changes on a conflict.
pub fn merge_release(repo: &Path, rev: &str, tag: &str) -> Result<String, String> {
    let wt = mine_worktree(repo)?;
    git(&wt, &["merge", "--no-edit", "-m", &format!("Merge release {tag}"), rev]).map_err(|e| {
        let _ = git(&wt, &["merge", "--abort"]);
        format!("merge conflict with {tag}, nothing changed: {e}")
    })
}

/// Takes the release as it is: your changes are kept on `mine-before-<tag>`, `mine` moves to the
/// tag. Refused while `mine` has uncommitted work, so nothing is lost. Returns the set-aside branch.
pub fn set_aside(repo: &Path, rev: &str, tag: &str) -> Result<String, String> {
    let wt = mine_worktree(repo)?;
    if !git(&wt, &["status", "--porcelain"])?.is_empty() {
        return Err("your changes have uncommitted work; commit or discard it first".into());
    }
    let kept = format!("{BRANCH}-before-{tag}");
    git(repo, &["branch", "-f", &kept, BRANCH])?;
    git(&wt, &["reset", "-q", "--hard", rev])?;
    Ok(kept)
}

pub fn revert(repo: &Path, sha: &str) -> Result<String, String> {
    let wt = mine_worktree(repo)?;
    let parents = git(&wt, &["rev-list", "--parents", "-n", "1", sha])?.split_whitespace().count();
    let mut args = vec!["revert", "--no-edit"];
    if parents > 2 {
        args.extend(["-m", "1"]); // a merge (an applied fix): undo it against its first parent
    }
    args.push(sha);
    git(&wt, &args).map_err(|e| {
        let _ = git(&wt, &["revert", "--abort"]);
        format!("can't revert cleanly: {e}")
    })
}

fn repo() -> Result<PathBuf, String> {
    crate::changes::app_repo().ok_or_else(|| "can't find the app's repo; set MR_APP_REPO".into())
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn personal_history() -> Result<History, String> {
    history(&repo()?)
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn personal_sync() -> Result<String, String> {
    sync_with_main(&repo()?)
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn personal_apply(app: tauri::AppHandle, branch: String) -> Result<String, String> {
    let r = apply(&repo()?, &branch)?;
    crate::eventlog::record(&app, None, "ui.personal_applied", &serde_json::json!({ "branch": branch }), Some("personal"));
    Ok(r)
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn personal_revert(app: tauri::AppHandle, sha: String) -> Result<String, String> {
    let r = revert(&repo()?, &sha)?;
    crate::eventlog::record(&app, None, "ui.personal_reverted", &serde_json::json!({ "sha": sha }), Some("personal"));
    Ok(r)
}

/// The note a god-mode fix session was started with ("Their note: …" in its prompt).
pub fn report_note(prompt: &str) -> Option<String> {
    let i = prompt.find("Their note: ")? + "Their note: ".len();
    Some(prompt[i..].lines().next()?.trim().chars().take(72).collect())
}

/// Commits whatever a fix session left uncommitted on its branch, then applies the branch to
/// `mine`. The end of "report an internal bug" (MR-47): one click from the fix session.
pub fn apply_fix(repo: &Path, worktree: &Path, branch: &str, note: Option<&str>) -> Result<String, String> {
    if !git(worktree, &["status", "--porcelain"])?.is_empty() {
        git(worktree, &["add", "-A"])?;
        let msg = format!("Fix: {}", note.unwrap_or("god-mode report"));
        git(worktree, &["commit", "-q", "-m", &msg])?;
    }
    apply(repo, branch)
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn fix_apply(app: tauri::AppHandle, session: String) -> Result<String, String> {
    use tauri::Manager;
    let req = app.state::<crate::eventlog::EventLog>().list(Some(&session), None, 200).map_err(|e| e.to_string())?
        .into_iter().find(|e| e.kind == "ui.session_requested" && e.payload["branch"].is_string()).ok_or("this session has no branch of its own to apply")?;
    let branch = req.payload["branch"].as_str().unwrap_or_default().to_owned();
    let worktree = PathBuf::from(req.payload["worktree"].as_str().or(req.payload["cwd"].as_str()).unwrap_or_default());
    let note = report_note(req.payload["prompt"].as_str().unwrap_or_default());
    let r = apply_fix(&repo()?, &worktree, &branch, note.as_deref())?;
    crate::eventlog::record(&app, Some(&session), "ui.fix_applied", &serde_json::json!({ "branch": branch }), Some("personal"));
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(["-c", "user.email=t@t", "-c", "user.name=t"]).args(args).status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn fixes_are_applied_to_mine_listed_and_revertable() {
        let root = std::env::temp_dir().join(format!("mr-mine-{}", ulid::Ulid::new()));
        let repo = root.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "v1\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "base"]);
        // A god-mode fix session's branch.
        run(&repo, &["branch", "mr/fix-lamp-ab12"]);
        run(&repo, &["checkout", "-q", "mr/fix-lamp-ab12"]);
        std::fs::write(repo.join("a.txt"), "v2\n").unwrap();
        run(&repo, &["commit", "-qam", "Fix the lamp"]);
        run(&repo, &["checkout", "-q", "main"]);

        let h = history(&repo).unwrap();
        assert_eq!(h.pending, vec![Pending { branch: "mr/fix-lamp-ab12".into(), commits: 1, subject: "Fix the lamp".into() }]);
        apply(&repo, "mr/fix-lamp-ab12").unwrap();
        let wt = PathBuf::from(&h.worktree);
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "v2\n");
        let h = history(&repo).unwrap();
        assert!(h.pending.is_empty());
        assert!(h.changes.iter().any(|c| c.subject == "Fix the lamp" && c.mine_only));
        // The main branch is untouched: these changes are yours only.
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "v1\n");
        // Revert the applied merge.
        let merge = h.changes.iter().find(|c| c.subject.starts_with("Merge")).unwrap().sha.clone();
        revert(&repo, &merge).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "v1\n");
        assert!(apply(&repo, "main").is_err());
    }

    #[test]
    fn a_release_is_previewed_merged_or_your_changes_set_aside() {
        let root = std::env::temp_dir().join(format!("mr-rel-{}", ulid::Ulid::new()));
        let repo = root.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.email", "t@t"]);
        run(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "v1\n").unwrap();
        std::fs::write(repo.join("b.txt"), "v1\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "base"]);
        let mine = mine_worktree(&repo).unwrap();
        std::fs::write(mine.join("a.txt"), "mine\n").unwrap();
        run(&mine, &["commit", "-qam", "My change"]);
        // A release that touches another file merges cleanly.
        std::fs::write(repo.join("b.txt"), "v2\n").unwrap();
        run(&repo, &["commit", "-qam", "Release work"]);
        run(&repo, &["tag", "v0.2.0"]);
        let p = preview_merge(&repo, "v0.2.0").unwrap().unwrap();
        assert_eq!(p, Preview { yours: 1, brings: 1, conflicts: vec![] });
        // One that touches your file conflicts, and the preview leaves mine as it was.
        std::fs::write(repo.join("a.txt"), "release\n").unwrap();
        run(&repo, &["commit", "-qam", "Release clash"]);
        run(&repo, &["tag", "v0.3.0"]);
        let head = git(&mine, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(preview_merge(&repo, "v0.3.0").unwrap().unwrap().conflicts, vec!["a.txt"]);
        assert_eq!(git(&mine, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(merge_release(&repo, "v0.3.0", "v0.3.0").is_err());
        assert_eq!(git(&mine, &["rev-parse", "HEAD"]).unwrap(), head);
        merge_release(&repo, "v0.2.0", "v0.2.0").unwrap();
        assert_eq!(std::fs::read_to_string(mine.join("b.txt")).unwrap(), "v2\n");
        assert_eq!(std::fs::read_to_string(mine.join("a.txt")).unwrap(), "mine\n");
        // Take the release: your changes stay on a branch.
        let merged = git(&mine, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(set_aside(&repo, "v0.3.0", "v0.3.0").unwrap(), "mine-before-v0.3.0");
        assert_eq!(std::fs::read_to_string(mine.join("a.txt")).unwrap(), "release\n");
        assert_eq!(git(&repo, &["rev-parse", "mine-before-v0.3.0"]).unwrap(), merged);
        // History this repo doesn't share (the scrubbed public export) has nothing to merge.
        run(&repo, &["checkout", "-q", "--orphan", "export"]);
        run(&repo, &["commit", "-qm", "export"]);
        run(&repo, &["tag", "v9.0.0"]);
        assert_eq!(preview_merge(&repo, "v9.0.0").unwrap(), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_fix_left_uncommitted_is_committed_then_applied() {
        let root = std::env::temp_dir().join(format!("mr-fix-{}", ulid::Ulid::new()));
        let repo = root.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.email", "t@t"]);
        run(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "v1\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "base"]);
        // A fix session's worktree that stopped before committing.
        let wt = root.join("app-worktrees").join("fix-x");
        run(&repo, &["worktree", "add", "-q", "-b", "mr/fix-x", wt.to_str().unwrap()]);
        std::fs::write(wt.join("a.txt"), "fixed\n").unwrap();
        apply_fix(&repo, &wt, "mr/fix-x", Some("the lamp is wrong")).unwrap();
        let mine = PathBuf::from(history(&repo).unwrap().worktree);
        assert_eq!(std::fs::read_to_string(mine.join("a.txt")).unwrap(), "fixed\n");
        assert!(history(&repo).unwrap().changes.iter().any(|c| c.subject == "Fix: the lamp is wrong"));
        // New work on main reaches your app; your fix stays.
        std::fs::write(repo.join("b.txt"), "new\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "new work on main"]);
        sync_with_main(&repo).unwrap();
        assert_eq!(std::fs::read_to_string(mine.join("b.txt")).unwrap(), "new\n");
        assert_eq!(std::fs::read_to_string(mine.join("a.txt")).unwrap(), "fixed\n");
        assert_eq!(report_note("God-mode mark…\n\nTheir note: the lamp is wrong\n\nWhat it showed"), Some("the lamp is wrong".into()));
        let _ = std::fs::remove_dir_all(&root);
    }
}
