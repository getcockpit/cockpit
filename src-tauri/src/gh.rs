//! Suggestions for the start picker, from the GitHub CLI (`gh`), run in the chosen folder.

use std::process::Command;

use tauri::AppHandle;

fn gh(cwd: &str, args: &[&str]) -> Result<serde_json::Value, String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let out = Command::new("gh")
        .args(args)
        .current_dir(cwd)
        .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{path}"))
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// `review`: open PRs waiting for my review. `address`: my open PRs in this folder's repo,
/// changes-requested first.
#[tauri::command]
pub fn gh_prs(app: AppHandle, cwd: String, mode: String) -> Result<serde_json::Value, String> {
    let cwd = crate::sidecar::expand_home(&app, &cwd);
    match mode.as_str() {
        "review" => gh(&cwd, &["search", "prs", "--review-requested=@me", "--state=open", "--limit", "20", "--json", "number,title,url,author,repository,updatedAt"]),
        "address" => {
            let mut v = gh(&cwd, &["pr", "list", "--author", "@me", "--state", "open", "--limit", "20", "--json", "number,title,url,updatedAt,reviewDecision"])?;
            if let Some(a) = v.as_array_mut() {
                a.sort_by_key(|p| if p["reviewDecision"] == "CHANGES_REQUESTED" { 0 } else { 1 });
            }
            Ok(v)
        }
        _ => Err(format!("unknown mode {mode}")),
    }
}
