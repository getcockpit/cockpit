//! What a session changed in its worktree (change map, MR-17), straight from git — the truth on
//! disk, not what the transcript claims. Also where god mode's marks go (MR-22).

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct Changed {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub status: String, // "modified" | "added" | "deleted" | "untracked"
    pub risky: Option<String>,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_with("git", dir, args)
}

// Never an empty error: the UI reads "" as "still loading" (a missing git once left the change map
// on "Reading git…" forever). 127 is the shell's "command not found", which some spawns report.
fn git_with(bin: &str, dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::sys::cmd(bin).arg("-C").arg(dir).args(args).output().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { NO_GIT.to_owned() } else { format!("git: {e}") })?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    Err(match (err.is_empty(), out.status.code()) {
        (false, _) => err,
        (true, Some(127)) => NO_GIT.to_owned(),
        (true, _) => format!("git {} failed ({})", args.first().unwrap_or(&""), out.status),
    })
}

pub const NO_GIT: &str = "git isn't installed";

/// Paths that deserve a second look, with the reason shown on the map.
pub fn risk_of(path: &str) -> Option<String> {
    let p = path.to_ascii_lowercase();
    let rules: [(&[&str], &str); 6] = [
        (&["migration", "schema.prisma", ".sql"], "database"),
        (&["auth", "session", "token", "password", "secret"], "auth"),
        (&["payment", "billing", "stripe", "invoice"], "payments"),
        (&["terraform", ".tf", "k8s", "helm", "docker", ".github/workflows"], "infra"),
        (&[".env", "credentials"], "secrets"),
        (&["package.json", "cargo.toml", "go.mod", "lock"], "dependencies"),
    ];
    rules.iter().find(|(needles, _)| needles.iter().any(|n| p.contains(n))).map(|(_, why)| (*why).to_owned())
}

pub fn changed_files(dir: &Path) -> Result<Vec<Changed>, String> {
    let mut out = vec![];
    for line in git(dir, &["diff", "--numstat", "HEAD"])?.lines() {
        let mut parts = line.split('\t');
        let (a, r, p) = (parts.next().unwrap_or("0"), parts.next().unwrap_or("0"), parts.next().unwrap_or(""));
        if p.is_empty() { continue; }
        let exists = dir.join(p).exists();
        out.push(Changed { path: p.into(), added: a.parse().unwrap_or(0), removed: r.parse().unwrap_or(0), status: if exists { "modified".into() } else { "deleted".into() }, risky: risk_of(p) });
    }
    for p in git(dir, &["ls-files", "--others", "--exclude-standard"])?.lines().filter(|l| !l.is_empty()) {
        let lines = std::fs::read_to_string(dir.join(p)).map(|s| s.lines().count() as u32).unwrap_or(0);
        out.push(Changed { path: p.into(), added: lines, removed: 0, status: "untracked".into(), risky: risk_of(p) });
    }
    Ok(out)
}

pub fn diff(dir: &Path, path: &str) -> Result<String, String> {
    let tracked = git(dir, &["diff", "--no-color", "HEAD", "--", path])?;
    if !tracked.is_empty() {
        return Ok(tracked);
    }
    // Untracked: show the whole file as added.
    let body = std::fs::read_to_string(dir.join(path)).map_err(|e| e.to_string())?;
    Ok(format!("+++ {path} (new file)\n{}", body.lines().map(|l| format!("+{l}\n")).collect::<String>()))
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn session_changes(app: tauri::AppHandle, cwd: String) -> Result<Vec<Changed>, String> {
    changed_files(Path::new(&crate::sidecar::expand_home(&app, &cwd)))
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn session_diff(app: tauri::AppHandle, cwd: String, path: String) -> Result<String, String> {
    if path.contains("..") {
        return Err("bad path".into());
    }
    diff(Path::new(&crate::sidecar::expand_home(&app, &cwd)), &path)
}

/// The last bytes a background task wrote (run_in_background): Claude Code streams its output to
/// <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output. Only such files are readable here.
// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn task_output(path: String) -> Result<String, String> {
    tail(Path::new(&path), 16 * 1024)
}

fn tail(path: &Path, max: u64) -> Result<String, String> {
    let task_file = path.extension().is_some_and(|e| e == "output")
        && path.parent().and_then(Path::file_name).is_some_and(|d| d == "tasks")
        && path.components().any(|c| c.as_os_str().to_string_lossy().starts_with("claude-"))
        && !path.components().any(|c| matches!(c, std::path::Component::ParentDir));
    if !task_file {
        return Err("not a background task's output".into());
    }
    tail_file(path, max)
}

/// The last `max` bytes of a file, as text.
pub fn tail_file(path: &Path, max: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(max))).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// The app's own repository: MR_APP_REPO, else the repo the running binary was built from.
pub fn app_repo() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MR_APP_REPO") {
        return Some(PathBuf::from(p));
    }
    repo_for(&std::env::current_exe().ok()?, Path::new(env!("CARGO_MANIFEST_DIR")))
}

/// The checkout above the binary; else, for a copy outside any checkout (the installed
/// /Applications/Cockpit.app, a stored self-build), the checkout it was compiled in, if it's still
/// on this machine. On anyone else's Mac neither exists, so there's no repo.
fn repo_for(exe: &Path, manifest: &Path) -> Option<PathBuf> {
    let is_repo = |d: &Path| d.join("src-tauri").is_dir() && d.join(".git").exists();
    exe.ancestors().find(|d| is_repo(d)).or_else(|| manifest.parent().filter(|d| is_repo(d))).map(main_checkout)
}

/// A build made inside a linked worktree still belongs to the main checkout: `mine`, god-mode
/// fixes and marks live next to it, not next to the worktree (else Rebuild looked for `mine` in
/// `<worktree>-worktrees/` and failed).
pub fn main_checkout(dir: &Path) -> PathBuf {
    if dir.join(".git").is_dir() {
        return dir.to_path_buf();
    }
    let out = crate::sys::cmd("git").arg("-C").arg(dir).args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).output();
    match out {
        Ok(o) if o.status.success() => {
            let common = crate::sys::native_path(String::from_utf8_lossy(&o.stdout).trim());
            common.parent().filter(|_| common.ends_with(".git")).map(Path::to_path_buf).unwrap_or_else(|| dir.to_path_buf())
        }
        _ => dir.to_path_buf(),
    }
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn app_repo_path() -> Result<String, String> {
    app_repo().map(|p| p.display().to_string()).ok_or_else(|| "can't find the app's repo; set MR_APP_REPO".into())
}

/// God mode: append a mark to evals/marks.jsonl in the app repo (the eval set, MR-22).
// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn godmode_save_mark(app: tauri::AppHandle, packet: serde_json::Value) -> Result<String, String> {
    let repo = app_repo().ok_or("can't find the app's repo; set MR_APP_REPO")?;
    let dir = repo.join("evals");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("marks.jsonl");
    let ev = crate::eventlog::record(&app, None, "ui.godmode_mark", &packet, packet["component"].as_str().map(|c| format!("godmode:{c}")).as_deref());
    let mut row = packet.clone();
    if let Some(ev) = ev {
        row["event_id"] = ev.id.into();
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| e.to_string())?;
    writeln!(f, "{row}").map_err(|e| e.to_string())?;
    Ok(repo.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_errors_are_never_empty() {
        let dir = std::env::temp_dir();
        assert_eq!(git_with("/nonexistent/git", &dir, &["status"]), Err(NO_GIT.to_owned()));
        #[cfg(unix)]
        {
            // A git that fails without a word, as a missing one does under some spawns (exit 127).
            use std::os::unix::fs::PermissionsExt;
            let silent = |code: u8| {
                let fake = dir.join(format!("mr-silent-git-{}", ulid::Ulid::new()));
                std::fs::write(&fake, format!("#!/bin/sh\nexit {code}\n")).unwrap();
                std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
                let r = git_with(fake.to_str().unwrap(), &dir, &["diff"]);
                let _ = std::fs::remove_file(fake);
                r
            };
            assert_eq!(silent(127), Err(NO_GIT.to_owned()));
            assert!(silent(3).unwrap_err().starts_with("git diff failed"));
        }
    }

    #[test]
    fn a_build_in_a_linked_worktree_belongs_to_the_main_checkout() {
        let root = std::env::temp_dir().join(format!("mr-main-{}", ulid::Ulid::new()));
        let repo = root.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| assert!(crate::sys::cmd("git").arg("-C").arg(&repo).args(["-c", "user.email=t@t", "-c", "user.name=t"]).args(args).status().unwrap().success());
        run(&["init", "-q", "-b", "main"]);
        run(&["commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = root.join("app-worktrees").join("installer");
        run(&["worktree", "add", "-q", "-b", "mr/installer", wt.to_str().unwrap()]);
        let repo = repo.canonicalize().unwrap();
        assert_eq!(main_checkout(&repo), repo);
        assert_eq!(main_checkout(&wt).canonicalize().unwrap(), repo);
        let plain = root.join("not-a-repo");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(main_checkout(&plain), plain);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_installed_copy_finds_the_checkout_it_was_built_in() {
        let root = std::env::temp_dir().join(format!("mr-installed-{}", ulid::Ulid::new()));
        let repo = root.join("app");
        std::fs::create_dir_all(repo.join("src-tauri")).unwrap();
        assert!(crate::sys::cmd("git").arg("-C").arg(&repo).args(["init", "-q", "-b", "main"]).status().unwrap().success());
        let installed = root.join("Applications/Cockpit.app/Contents/MacOS/Cockpit");
        let in_repo = repo.join("src-tauri/target/debug/Cockpit");
        assert_eq!(repo_for(&in_repo, Path::new("/nowhere/src-tauri")), Some(repo.clone()));
        assert_eq!(repo_for(&installed, &repo.join("src-tauri")), Some(repo.clone()));
        assert_eq!(repo_for(&installed, Path::new("/nowhere/src-tauri")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_modified_and_untracked_files_with_risk_and_diffs() {
        let dir = std::env::temp_dir().join(format!("mr-changes-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(dir.join("db/migrations")).unwrap();
        std::fs::write(dir.join("a.ts"), "one\n").unwrap();
        let run = |args: &[&str]| assert!(crate::sys::cmd("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        run(&["init", "-q", "-b", "main"]);
        run(&["add", "."]);
        run(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("a.ts"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("db/migrations/0001.sql"), "create table x();\n").unwrap();
        let files = changed_files(&dir).unwrap();
        let a = files.iter().find(|f| f.path == "a.ts").unwrap();
        assert_eq!((a.added, a.removed, a.status.as_str()), (1, 0, "modified"));
        let m = files.iter().find(|f| f.path.ends_with("0001.sql")).unwrap();
        assert_eq!((m.status.as_str(), m.risky.as_deref()), ("untracked", Some("database")));
        assert!(diff(&dir, "a.ts").unwrap().contains("+two"));
        assert!(diff(&dir, "db/migrations/0001.sql").unwrap().contains("+create table"));
    }

    #[test]
    fn reads_the_tail_of_task_output_only() {
        let dir = std::env::temp_dir().join(format!("claude-test-{}", ulid::Ulid::new())).join("tasks");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("b1.output");
        std::fs::write(&out, "first\nlast line\n").unwrap();
        assert_eq!(tail(&out, 1024).unwrap(), "first\nlast line\n");
        assert_eq!(tail(&out, 10).unwrap(), "last line\n");
        let other = dir.join("notes.txt");
        std::fs::write(&other, "x").unwrap();
        assert!(tail(&other, 1024).is_err());
        assert!(tail(Path::new("/etc/passwd"), 1024).is_err());
        assert!(tail(&dir.join("../tasks/b1.output"), 1024).is_err());
    }

    #[test]
    fn risk_rules() {
        assert_eq!(risk_of("src/auth/session.ts").as_deref(), Some("auth"));
        assert_eq!(risk_of("ui/src/App.tsx"), None);
    }
}
