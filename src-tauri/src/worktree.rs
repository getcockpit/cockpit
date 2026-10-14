//! One git worktree per session (decision 7), as a sibling of the repo: `<repo>-worktrees/<name>`,
//! on a new branch `mr/<name>`, so parallel sessions never touch each other's files.

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Worktree {
    pub repo: PathBuf,
    pub path: PathBuf,
    pub branch: String,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// The repo root containing `dir`, if it's inside a git repository.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    git(dir, &["rev-parse", "--show-toplevel"]).ok().map(PathBuf::from)
}

/// A short, readable name from the prompt: "fix the flaky contract test" → "fix-flaky-contract-test".
pub fn slug(prompt: &str) -> String {
    const STOP: [&str; 8] = ["the", "a", "an", "to", "of", "in", "and", "for"];
    let words: Vec<String> = prompt
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty() && !STOP.contains(&w.to_ascii_lowercase().as_str()))
        .take(5)
        .map(|w| w.to_ascii_lowercase())
        .collect();
    let s = words.join("-");
    if s.is_empty() { "session".into() } else { s.chars().take(40).collect() }
}

/// Creates a worktree for a new session, branching from the repo's current HEAD.
pub fn create(dir: &Path, prompt: &str, id: &str) -> Result<Worktree, String> {
    let repo = repo_root(dir).ok_or("not a git repository")?;
    let name = format!("{}-{}", slug(prompt), &id[id.len().saturating_sub(4)..].to_ascii_lowercase());
    let parent = repo.parent().ok_or("repo has no parent folder")?;
    let base = parent.join(format!("{}-worktrees", repo.file_name().and_then(|n| n.to_str()).unwrap_or("repo")));
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let path = base.join(&name);
    let branch = format!("mr/{name}");
    git(&repo, &["worktree", "add", "-b", &branch, path.to_str().ok_or("bad path")?, "HEAD"])?;
    Ok(Worktree { repo, path, branch })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_short_and_readable() {
        assert_eq!(slug("Fix the flaky contract test in api-tests"), "fix-flaky-contract-test-api");
        assert_eq!(slug("!!!"), "session");
    }

    #[test]
    fn creates_a_sibling_worktree_on_a_new_branch() {
        let root = std::env::temp_dir().join(format!("mr-wt-{}", ulid::Ulid::new()));
        let repo = root.join("demo");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]] {
            assert!(Command::new("git").arg("-C").arg(&repo).args(&args).status().unwrap().success());
        }
        let wt = create(&repo.join("."), "Add retry worker", "01ABCDEFGHJK").unwrap();
        assert_eq!(wt.branch, "mr/add-retry-worker-ghjk");
        assert!(wt.path.canonicalize().unwrap().starts_with(root.canonicalize().unwrap().join("demo-worktrees")), "{:?}", wt.path);
        assert!(wt.path.join(".git").exists());
        assert_eq!(repo_root(&wt.path).unwrap().canonicalize().unwrap(), wt.path.canonicalize().unwrap());
        assert!(repo_root(&root).is_none());
    }
}
