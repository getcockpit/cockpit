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

/// `review`: open PRs waiting for my review. `address`: my open PRs anywhere (not just this
/// folder's repo), changes-requested first. Both work from any folder (MR-48).
#[tauri::command]
pub fn gh_prs(app: AppHandle, cwd: String, mode: String) -> Result<serde_json::Value, String> {
    let cwd = crate::sidecar::expand_home(&app, &cwd);
    let cwd = if std::path::Path::new(&cwd).is_dir() { cwd } else { std::env::var("HOME").unwrap_or_default() };
    match mode.as_str() {
        "review" => gh(&cwd, &["search", "prs", "--review-requested=@me", "--state=open", "--limit", "20", "--json", "number,title,url,author,repository,updatedAt"]),
        "address" => {
            let mut v = gh(&cwd, &["search", "prs", "--author=@me", "--state=open", "--limit", "30", "--json", "number,title,url,repository,updatedAt"])?;
            let flagged: Vec<String> = gh(&cwd, &["search", "prs", "--author=@me", "--state=open", "--review=changes_requested", "--limit", "30", "--json", "url"])
                .ok().and_then(|x| x.as_array().map(|a| a.iter().filter_map(|p| p["url"].as_str().map(str::to_owned)).collect())).unwrap_or_default();
            if let Some(a) = v.as_array_mut() {
                for p in a.iter_mut() {
                    if flagged.iter().any(|u| Some(u.as_str()) == p["url"].as_str()) {
                        p["reviewDecision"] = "CHANGES_REQUESTED".into();
                    }
                }
                a.sort_by_key(|p| if p["reviewDecision"] == "CHANGES_REQUESTED" { 0 } else { 1 });
            }
            Ok(v)
        }
        _ => Err(format!("unknown mode {mode}")),
    }
}

/// `owner/name` from a PR URL, `owner/name#123` or `owner/name`.
pub fn repo_slug(spec: &str) -> Option<String> {
    let s = spec.trim().trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("github.com/");
    let mut parts = s.split(['/', '#']).filter(|p| !p.is_empty());
    let (owner, name) = (parts.next()?, parts.next()?);
    (!owner.chars().all(|c| c.is_ascii_digit()) && owner != "pull").then(|| format!("{owner}/{name}"))
}

fn origin_matches(dir: &std::path::Path, slug: &str) -> bool {
    Command::new("git").arg("-C").arg(dir).args(["remote", "get-url", "origin"]).output().ok()
        .filter(|o| o.status.success())
        .map(|o| { let u = String::from_utf8_lossy(&o.stdout).trim().trim_end_matches(".git").to_lowercase(); u.ends_with(&format!("/{}", slug.to_lowercase())) || u.ends_with(&format!(":{}", slug.to_lowercase())) })
        .unwrap_or(false)
}

/// Where a PR's repo is cloned on this Mac: the usual layouts under HOME, then the folders you
/// recently worked in. Only a folder whose `origin` is that repo counts.
pub fn find_clone(home: &std::path::Path, slug: &str, extra: &[String]) -> Option<String> {
    let (owner, name) = slug.split_once('/')?;
    let mut cands: Vec<std::path::PathBuf> = ["go/github.com", "go/src/github.com", "github.com", "src/github.com", "code", "src", "dev", "projects", "Developer", "repos", "git", "work"]
        .iter().flat_map(|b| [home.join(b).join(owner).join(name), home.join(b).join(name)]).collect();
    cands.push(home.join(name));
    cands.extend(extra.iter().map(std::path::PathBuf::from));
    cands.into_iter().find(|d| d.is_dir() && origin_matches(d, slug)).map(|d| d.display().to_string())
}

/// The local clone for a PR (URL or owner/name), or null when it can't be found.
#[tauri::command]
pub fn pr_repo(spec: String) -> Option<String> {
    let slug = repo_slug(&spec)?;
    let home = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let recent: Vec<String> = crate::folders::recent_folders().into_iter().map(|f| f.path).collect();
    find_clone(&home, &slug, &recent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_repo_from_any_pr_spec() {
        assert_eq!(repo_slug("https://github.com/acme/platform/pull/482"), Some("acme/platform".into()));
        assert_eq!(repo_slug("acme/platform#12"), Some("acme/platform".into()));
        assert_eq!(repo_slug("482"), None);
    }

    #[test]
    fn finds_a_clone_only_by_its_origin() {
        let home = std::env::temp_dir().join(format!("mr-home-{}", ulid::Ulid::new()));
        let right = home.join("go/github.com/acme/shop");
        let wrong = home.join("code/shop");
        for (d, url) in [(&right, "git@github.com:acme/shop.git"), (&wrong, "https://github.com/someone-else/shop")] {
            std::fs::create_dir_all(d).unwrap();
            assert!(Command::new("git").arg("-C").arg(d).args(["init", "-q"]).status().unwrap().success());
            assert!(Command::new("git").arg("-C").arg(d).args(["remote", "add", "origin", url]).status().unwrap().success());
        }
        assert_eq!(find_clone(&home, "acme/shop", &[]), Some(right.display().to_string()));
        assert_eq!(find_clone(&home, "acme/other", &[]), None);
        let _ = std::fs::remove_dir_all(&home);
    }
}
