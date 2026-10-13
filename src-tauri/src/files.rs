//! File chips (MR-112): a file Claude names in a reply shows as a chip, and clicking it shows the
//! file in Finder. Relative paths resolve against the session's folder, `~` against home.
//! `ui.file_revealed` is logged here, in the command that performs it.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;
use tauri::{AppHandle, Manager};

/// Where a referenced path points: absolute as is, `~/…` under home, anything else under `cwd`.
fn resolve(cwd: &Path, path: &str, home: Option<&Path>) -> PathBuf {
    match (path.strip_prefix("~/"), home) {
        (Some(rest), Some(h)) => h.join(rest),
        _ if path.starts_with('/') => PathBuf::from(path),
        _ => cwd.join(path),
    }
}

fn resolve_for(app: &AppHandle, cwd: &str, path: &str) -> PathBuf {
    let cwd = crate::sidecar::expand_home(app, cwd);
    let home = app.path().home_dir().ok();
    resolve(Path::new(&cwd), path, home.as_deref())
}

/// Which of the referenced paths exist, in order. One call per message, not per chip.
#[tauri::command(async)]
pub fn files_exist(app: AppHandle, cwd: String, paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| resolve_for(&app, &cwd, p).exists()).collect()
}

/// Shows the file in Finder, selected (`open -R`).
#[tauri::command(async)]
pub fn file_reveal(app: AppHandle, session: Option<String>, cwd: String, path: String) -> Result<(), String> {
    let full = resolve_for(&app, &cwd, &path);
    if !full.exists() {
        return Err(format!("not found: {}", full.display()));
    }
    #[cfg(target_os = "macos")]
    let ok = Command::new("open").arg("-R").arg(&full).status().map_err(|e| e.to_string())?.success();
    // Explorer's exit code is 1 even when it worked.
    #[cfg(windows)]
    let ok = Command::new("explorer").arg(format!("/select,{}", full.display())).status().is_ok();
    #[cfg(all(unix, not(target_os = "macos")))]
    let ok = Command::new("xdg-open").arg(full.parent().unwrap_or(&full)).status().map_err(|e| e.to_string())?.success();
    if !ok {
        return Err(format!("Finder couldn't show {}", full.display()));
    }
    crate::eventlog::record(&app, session.as_deref(), "ui.file_revealed", &json!({ "path": full.to_string_lossy() }), None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_home_and_absolute() {
        let (cwd, home) = (Path::new("/repo"), Some(Path::new("/Users/me")));
        assert_eq!(resolve(cwd, "src/a.ts", home), PathBuf::from("/repo/src/a.ts"));
        assert_eq!(resolve(cwd, "~/x/y.md", home), PathBuf::from("/Users/me/x/y.md"));
        assert_eq!(resolve(cwd, "/etc/hosts", home), PathBuf::from("/etc/hosts"));
        assert_eq!(resolve(cwd, "~/x", None), PathBuf::from("/repo/~/x"));
    }
}
