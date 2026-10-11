//! What a session changed in its worktree (change map, MR-17), straight from git — the truth on
//! disk, not what the transcript claims. Also where god mode's marks go (MR-22).

use std::path::{Path, PathBuf};
use std::process::Command;

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
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into_owned()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) }
}

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
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|d| d.join("src-tauri").is_dir() && d.join(".git").exists()).map(Path::to_path_buf)
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
    fn lists_modified_and_untracked_files_with_risk_and_diffs() {
        let dir = std::env::temp_dir().join(format!("mr-changes-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(dir.join("db/migrations")).unwrap();
        std::fs::write(dir.join("a.ts"), "one\n").unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
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
