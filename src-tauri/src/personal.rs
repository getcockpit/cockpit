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

pub fn apply(repo: &Path, branch: &str) -> Result<String, String> {
    if !branch.starts_with("mr/") {
        return Err("only mr/* branches can be applied".into());
    }
    let wt = mine_worktree(repo)?;
    git(&wt, &["merge", "--no-ff", "--no-edit", branch]).map_err(|e| {
        let _ = git(&wt, &["merge", "--abort"]);
        format!("merge conflict, nothing applied: {e}")
    })
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

#[tauri::command]
pub fn personal_history() -> Result<History, String> {
    history(&repo()?)
}

#[tauri::command]
pub fn personal_apply(app: tauri::AppHandle, branch: String) -> Result<String, String> {
    let r = apply(&repo()?, &branch)?;
    crate::eventlog::record(&app, None, "ui.personal_applied", &serde_json::json!({ "branch": branch }), Some("personal"));
    Ok(r)
}

#[tauri::command]
pub fn personal_revert(app: tauri::AppHandle, sha: String) -> Result<String, String> {
    let r = revert(&repo()?, &sha)?;
    crate::eventlog::record(&app, None, "ui.personal_reverted", &serde_json::json!({ "sha": sha }), Some("personal"));
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
}
