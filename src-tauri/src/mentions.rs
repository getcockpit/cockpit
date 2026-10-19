//! @ mentions in the message box (MR-108): the files and folders a session can point Claude at.
//! In a git repo it's what git sees (tracked plus untracked, ignores respected), like Claude Code's
//! own @ menu; elsewhere a shallow walk that skips hidden and dependency folders. Folders end in `/`.
//! A path typed from outside the folder (`~/`, `../`, `/`) lists that one folder instead.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX: usize = 20_000;
const SKIP: [&str; 6] = ["node_modules", "target", "dist", "build", "__pycache__", ".git"];

fn from_git(cwd: &Path) -> Option<Vec<String>> {
    let out = Command::new("git").arg("-C").arg(cwd).args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let files: Vec<String> = String::from_utf8_lossy(&out.stdout).split('\0').filter(|f| !f.is_empty()).take(MAX).map(str::to_owned).collect();
    Some(with_folders(files))
}

fn walk(dir: &Path, rel: &str, depth: usize, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= MAX {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        let path = format!("{rel}{name}");
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            out.push(format!("{path}/"));
            if depth > 0 {
                walk(&e.path(), &format!("{path}/"), depth - 1, out);
            }
        } else {
            out.push(path);
        }
    }
}

/// Files plus every folder above them, folders first so a short query lands on the folder.
fn with_folders(files: Vec<String>) -> Vec<String> {
    let mut dirs = BTreeSet::new();
    for f in &files {
        let mut at = 0;
        while let Some(i) = f[at..].find('/') {
            at += i + 1;
            dirs.insert(f[..at].to_owned());
        }
    }
    dirs.into_iter().chain(files).collect()
}

pub fn paths(cwd: &Path) -> Vec<String> {
    from_git(cwd).unwrap_or_else(|| {
        let mut out = Vec::new();
        walk(cwd, "", 5, &mut out);
        out
    })
}

// Off the main thread: a big repo takes a moment to list (MR-57).
#[tauri::command(async)]
pub fn session_paths(cwd: String) -> Vec<String> {
    paths(Path::new(&cwd))
}

/// Where a typed folder like `~/x/`, `../` or `/tmp/` is, from the session folder.
fn resolve(cwd: &Path, dir: &str) -> Option<PathBuf> {
    if dir == "~" || dir.starts_with("~/") {
        return Some(dirs::home_dir()?.join(dir[1..].trim_start_matches('/')));
    }
    Some(cwd.join(dir))
}

/// One folder's entries, each as typed (`dir` plus the name), folders ending in `/`, sorted.
pub fn dir_entries(cwd: &Path, dir: &str) -> Vec<String> {
    let Some(rd) = resolve(cwd, dir).and_then(|p| std::fs::read_dir(p).ok()) else { return Vec::new() };
    let mut out: Vec<String> = rd
        .flatten()
        .take(MAX)
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            // Follows links, so a linked folder can be opened too.
            let folder = std::fs::metadata(e.path()).is_ok_and(|m| m.is_dir());
            format!("{dir}{name}{}", if folder { "/" } else { "" })
        })
        .collect();
    out.sort();
    out
}

#[tauri::command(async)]
pub fn mention_dir(cwd: String, dir: String) -> Vec<String> {
    dir_entries(Path::new(&cwd), &dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_come_from_file_paths() {
        let got = with_folders(vec!["a.md".into(), "src/x/y.rs".into(), "src/z.rs".into()]);
        assert_eq!(got, vec!["src/", "src/x/", "a.md", "src/x/y.rs", "src/z.rs"]);
    }

    #[test]
    fn git_respects_ignores_and_walk_skips_hidden() {
        let root = std::env::temp_dir().join(format!("mr-mentions-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        std::fs::write(root.join("node_modules/pkg/i.js"), "").unwrap();
        std::fs::write(root.join(".hidden/x"), "").unwrap();
        // No repo: the walk.
        let mut got = paths(&root);
        got.sort();
        assert_eq!(got, vec!["src/", "src/main.rs"]);
        // A repo: git's view, with its ignores.
        assert!(Command::new("git").arg("-C").arg(&root).arg("init").output().unwrap().status.success());
        std::fs::write(root.join(".gitignore"), "node_modules/\n.hidden/\n").unwrap();
        assert_eq!(paths(&root), vec!["src/", ".gitignore", "src/main.rs"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_a_folder_outside_the_session_folder() {
        let root = std::env::temp_dir().join(format!("mr-mentions-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(root.join("app/src")).unwrap();
        std::fs::create_dir_all(root.join("other")).unwrap();
        std::fs::write(root.join("notes.md"), "").unwrap();
        let cwd = root.join("app");
        assert_eq!(dir_entries(&cwd, "../"), vec!["../app/", "../notes.md", "../other/"]);
        assert_eq!(dir_entries(&cwd, "./"), vec!["./src/"]);
        let abs = format!("{}/", root.display());
        assert_eq!(dir_entries(&cwd, &abs), vec![format!("{abs}app/"), format!("{abs}notes.md"), format!("{abs}other/")]);
        assert_eq!(dir_entries(&cwd, "../missing/"), Vec::<String>::new());
        assert_eq!(resolve(&cwd, "~/x/"), dirs::home_dir().map(|h| h.join("x/")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
