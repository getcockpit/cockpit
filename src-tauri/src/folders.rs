//! Work-folder picking (MR-36): the folders you actually work in, newest first, read from Claude
//! Code's own history (`~/.claude/projects/*/<session>.jsonl` carries each session's `cwd`).
//! Worktrees fold into their repo, and temp folders are skipped.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Folder {
    pub path: String,
    pub name: String,
    pub repo: bool,
    pub at: u64,
}

/// `<repo>-worktrees/<name>` → `<repo>`; Claude Code's `.claude/worktrees/<name>` → the repo too.
pub fn fold_worktree(p: &str) -> String {
    for marker in ["-worktrees/", "/.claude/worktrees/"] {
        if let Some(i) = p.rfind(marker) {
            // Only a worktree's root folds; deeper paths are real folders that happen to sit inside one.
            if !p[i + marker.len()..].trim_end_matches('/').contains('/') {
                return p[..i].to_owned();
            }
        }
    }
    p.to_owned()
}

fn is_temp(p: &str) -> bool {
    ["/tmp/", "/private/", "/var/folders/"].iter().any(|t| p.starts_with(t) || p.contains("/T/"))
}

fn cwd_of(jsonl: &Path) -> Option<String> {
    let f = std::fs::File::open(jsonl).ok()?;
    BufReader::new(f).lines().take(40).map_while(Result::ok).find_map(|l| {
        serde_json::from_str::<serde_json::Value>(&l).ok()?.get("cwd")?.as_str().map(str::to_owned)
    })
}

pub fn scan(projects: &Path, limit: usize) -> Vec<Folder> {
    let mut newest: Vec<(u64, PathBuf)> = std::fs::read_dir(projects).into_iter().flatten().flatten().filter_map(|d| {
        std::fs::read_dir(d.path()).ok()?.flatten().filter(|f| f.path().extension().is_some_and(|e| e == "jsonl")).filter_map(|f| {
            let at = f.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
            Some((at, f.path()))
        }).max_by_key(|x| x.0)
    }).collect();
    newest.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out: Vec<Folder> = Vec::new();
    for (at, file) in newest {
        let Some(cwd) = cwd_of(&file) else { continue };
        let path = fold_worktree(&cwd);
        if is_temp(&path) || out.iter().any(|f| f.path == path) || !Path::new(&path).is_dir() {
            continue;
        }
        let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
        out.push(Folder { repo: Path::new(&path).join(".git").exists(), path, name, at });
        if out.len() >= limit {
            break;
        }
    }
    out
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn recent_folders() -> Vec<Folder> {
    let home = std::env::var("HOME").unwrap_or_default();
    scan(&Path::new(&home).join(".claude/projects"), 15)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_worktrees_into_their_repo() {
        assert_eq!(fold_worktree("/u/app-worktrees/mr-1-x"), "/u/app");
        assert_eq!(fold_worktree("/u/app/.claude/worktrees/fix"), "/u/app");
        assert_eq!(fold_worktree("/u/app"), "/u/app");
        assert_eq!(fold_worktree("/u/app-worktrees/x/sub/dir"), "/u/app-worktrees/x/sub/dir");
    }

    #[test]
    fn scans_newest_first_and_dedupes() {
        let root = std::env::temp_dir().join(format!("mr-folders-{}", ulid::Ulid::new()));
        // Temp paths are skipped by design, so the fake work folders live under target/.
        let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("mr-work-{}", ulid::Ulid::new()));
        let (a, b) = (base.join("alpha"), base.join("beta"));
        std::fs::create_dir_all(a.join(".git")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        for (dir, cwd, n) in [("p1", a.display().to_string(), 1), ("p2", format!("{}-worktrees/x", a.display()), 2), ("p3", b.display().to_string(), 3)] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("s.jsonl"), format!("{{\"type\":\"x\"}}\n{}\n", serde_json::json!({ "cwd": cwd }))).unwrap();
            let _ = n;
            std::thread::sleep(std::time::Duration::from_millis(1100));
        }
        let got = scan(&root, 10);
        assert_eq!(got.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["beta", "alpha"]);
        assert!(got[1].repo && !got[0].repo);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&base);
    }
}
