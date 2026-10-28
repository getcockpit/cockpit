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
/// Either separator: Windows cwds use `\`.
pub fn fold_worktree(p: &str) -> String {
    let fwd = p.replace('\\', "/"); // same byte offsets as `p`
    for marker in ["-worktrees/", "/.claude/worktrees/"] {
        if let Some(i) = fwd.rfind(marker) {
            // Only a worktree's root folds; deeper paths are real folders that happen to sit inside one.
            if !fwd[i + marker.len()..].trim_end_matches('/').contains('/') {
                return p[..i].to_owned();
            }
        }
    }
    p.to_owned()
}

fn is_temp(p: &str) -> bool {
    let p = p.replace('\\', "/");
    ["/tmp/", "/private/", "/var/folders/"].iter().any(|t| p.starts_with(t) || p.contains("/T/")) || p.to_ascii_lowercase().contains("/appdata/local/temp/")
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
    scan(&Path::new(&crate::sys::home_str()).join(".claude").join("projects"), 15)
}

/// `~/x` → `<home>/x`; other paths as they are.
fn expand(path: &str, home: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(std::path::is_separator) => PathBuf::from(format!("{home}{rest}")),
        _ => PathBuf::from(path),
    }
}

/// Whether a typed path is already a folder, so the picker can offer to create it instead.
#[tauri::command(async)]
pub fn folder_exists(path: String) -> bool {
    expand(path.trim(), &crate::sys::home_str()).is_dir()
}

/// Creates a typed folder (and its parents) so a new workspace or session can start there.
/// Absolute or `~` paths only; returns the full path.
pub fn create(path: &str, home: &str) -> Result<String, String> {
    let full = expand(path.trim(), home);
    if !full.is_absolute() {
        return Err(format!("{path} isn't a full path"));
    }
    if full.exists() && !full.is_dir() {
        return Err(format!("{path} is a file"));
    }
    std::fs::create_dir_all(&full).map_err(|e| format!("couldn't create {path}: {e}"))?;
    Ok(full.display().to_string())
}

#[tauri::command(async)]
pub fn folder_create(path: String) -> Result<String, String> {
    create(&path, &crate::sys::home_str())
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
        assert_eq!(fold_worktree(r"C:\u\app-worktrees\mr-1-x"), r"C:\u\app");
        assert_eq!(fold_worktree(r"C:\u\app\.claude\worktrees\fix\"), r"C:\u\app");
        assert_eq!(fold_worktree(r"C:\u\app-worktrees\x\sub"), r"C:\u\app-worktrees\x\sub");
        assert!(is_temp(r"C:\Users\me\AppData\Local\Temp\x") && !is_temp(r"C:\Users\me\code\app"));
    }

    #[test]
    fn creates_typed_folders_with_parents() {
        let home = std::env::temp_dir().join(format!("mr-home-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&home).unwrap();
        let h = home.display().to_string();
        let got = create("~/code/new-app", &h).unwrap();
        assert_eq!(got, format!("{h}/code/new-app"));
        assert!(home.join("code/new-app").is_dir());
        assert_eq!(create("~/code/new-app", &h).unwrap(), got, "existing folder is fine");
        std::fs::write(home.join("f"), "").unwrap();
        assert!(create("~/f", &h).is_err());
        assert!(create("relative/x", &h).is_err());
        let _ = std::fs::remove_dir_all(&home);
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
