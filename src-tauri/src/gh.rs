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

// My open PRs with their review threads, in one call (search can't see threads); `scope` is
// empty or ` repo:owner/name` (MR-79).
fn mine_query(scope: &str) -> String {
    format!("query {{ viewer {{ login }} search(query: \"is:pr is:open author:@me archived:false{scope}\", type: ISSUE, first: 30) {{ nodes {{ ... on PullRequest {{ number title url updatedAt isDraft reviewDecision repository {{ nameWithOwner }} reviewThreads(first: 100) {{ nodes {{ isResolved comments(last: 1) {{ nodes {{ author {{ login }} }} }} }} }} }} }} }} }}")
}

/// `owner/name` made only of the characters GitHub allows, so it's safe inside a search query.
fn safe_slug(slug: &str) -> Option<&str> {
    let (owner, name) = slug.split_once('/')?;
    let ok = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (ok(owner) && ok(name)).then_some(slug)
}

/// What's worth addressing in my open PRs: `waiting` counts unresolved threads whose last word is
/// someone else's (a reply of mine means the ball is with them). Changes requested first, then
/// PRs with waiting threads, then the rest, newest first within each.
pub fn rank_mine(data: &serde_json::Value) -> serde_json::Value {
    let me = data["viewer"]["login"].as_str().unwrap_or_default();
    let mut prs: Vec<serde_json::Value> = data["search"]["nodes"].as_array().cloned().unwrap_or_default().into_iter()
        .filter(|p| p["number"].is_number())
        .map(|mut p| {
            let threads = p["reviewThreads"]["nodes"].as_array().cloned().unwrap_or_default();
            let open: Vec<_> = threads.iter().filter(|t| t["isResolved"] == false).collect();
            let waiting = open.iter().filter(|t| t["comments"]["nodes"][0]["author"]["login"].as_str() != Some(me)).count();
            p["unresolved"] = open.len().into();
            p["waiting"] = waiting.into();
            p.as_object_mut().map(|o| o.remove("reviewThreads"));
            p
        })
        .collect();
    let tier = |p: &serde_json::Value| if p["reviewDecision"] == "CHANGES_REQUESTED" { 0 } else if p["waiting"].as_u64().unwrap_or(0) > 0 { 1 } else { 2 };
    prs.sort_by(|a, b| tier(a).cmp(&tier(b)).then_with(|| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str())));
    prs.into()
}

/// `review`: open PRs waiting for my review. `address`: my open PRs, the ones with something to
/// address first. Both work from any folder (MR-48): every repo by default, or just `repo` (MR-79).
// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn gh_prs(app: AppHandle, cwd: String, mode: String, repo: Option<String>) -> Result<serde_json::Value, String> {
    let cwd = crate::sidecar::expand_home(&app, &cwd);
    let cwd = if std::path::Path::new(&cwd).is_dir() { cwd } else { std::env::var("HOME").unwrap_or_default() };
    let repo = match repo.as_deref() {
        Some(r) => Some(safe_slug(r).ok_or_else(|| format!("not a GitHub repo: {r}"))?),
        None => None,
    };
    match mode.as_str() {
        "review" => {
            let only = repo.map(|r| format!("--repo={r}"));
            let mut args = vec!["search", "prs", "--review-requested=@me", "--state=open", "--limit", "20", "--json", "number,title,url,author,repository,updatedAt,isDraft"];
            args.extend(only.as_deref());
            gh(&cwd, &args)
        }
        "address" => {
            let q = mine_query(&repo.map(|r| format!(" repo:{r}")).unwrap_or_default());
            Ok(rank_mine(&gh(&cwd, &["api", "graphql", "-f", &format!("query={q}")])?["data"]))
        }
        _ => Err(format!("unknown mode {mode}")),
    }
}

/// `owner/name` of a git remote URL on GitHub (https or ssh), or None.
fn github_slug(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = u.split_once("github.com/").or_else(|| u.split_once("github.com:"))?.1;
    safe_slug(rest).map(str::to_owned)
}

/// The GitHub repo of a folder (its `origin`), for the start picker's "this repo only" toggle (MR-79).
#[tauri::command(async)]
pub fn gh_repo(app: AppHandle, cwd: String) -> Option<String> {
    let cwd = crate::sidecar::expand_home(&app, &cwd);
    let out = Command::new("git").args(["-C", &cwd, "remote", "get-url", "origin"]).output().ok().filter(|o| o.status.success())?;
    github_slug(&String::from_utf8_lossy(&out.stdout))
}

/// `owner`, `name` and the number from a PR URL.
pub fn pr_parts(url: &str) -> Option<(String, String, u64)> {
    let s = url.trim().trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("github.com/");
    let p: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    match p.as_slice() {
        [owner, name, "pull", n, ..] => Some(((*owner).into(), (*name).into(), n.parse().ok()?)),
        _ => None,
    }
}

/// What auto-review needs to decide on a PR (MR-72): is it a draft, its head commit and when it
/// was made, and when I last reviewed it on GitHub. One GraphQL call.
// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn gh_review_state(url: String) -> Result<serde_json::Value, String> {
    let (owner, name, n) = pr_parts(&url).ok_or_else(|| format!("not a PR URL: {url}"))?;
    let q = "query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){isDraft headRefOid viewerLatestReview{submittedAt} commits(last:1){nodes{commit{committedDate}}}}}}";
    let home = std::env::var("HOME").unwrap_or_default();
    let v = gh(&home, &["api", "graphql", "-f", &format!("query={q}"), "-F", &format!("o={owner}"), "-F", &format!("n={name}"), "-F", &format!("num={n}")])?;
    let pr = &v["data"]["repository"]["pullRequest"];
    if pr.is_null() { return Err(format!("PR not found: {url}")); }
    Ok(serde_json::json!({
        "isDraft": pr["isDraft"].as_bool().unwrap_or(false),
        "headSha": pr["headRefOid"],
        "lastCommitAt": pr["commits"]["nodes"][0]["commit"]["committedDate"],
        "myLastReviewAt": pr["viewerLatestReview"]["submittedAt"],
    }))
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
// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn pr_repo(spec: String) -> Option<String> {
    let slug = repo_slug(&spec)?;
    let home = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let recent: Vec<String> = crate::folders::recent_folders().into_iter().map(|f| f.path).collect();
    find_clone(&home, &slug, &recent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_repo_from_any_pr_spec() {
        assert_eq!(repo_slug("https://github.com/acme/platform/pull/482"), Some("acme/platform".into()));
        assert_eq!(repo_slug("acme/platform#12"), Some("acme/platform".into()));
        assert_eq!(repo_slug("482"), None);
    }

    #[test]
    fn ranks_my_prs_by_what_waits_on_me() {
        let t = |resolved: bool, by: &str| json!({ "isResolved": resolved, "comments": { "nodes": [{ "author": { "login": by } }] } });
        let data = json!({ "viewer": { "login": "me" }, "search": { "nodes": [
            { "number": 1, "updatedAt": "2026-10-03", "reviewThreads": { "nodes": [] } },
            { "number": 2, "updatedAt": "2026-10-01", "reviewThreads": { "nodes": [t(false, "dana"), t(false, "me"), t(true, "dana")] } },
            { "number": 3, "updatedAt": "2026-10-02", "reviewThreads": { "nodes": [t(false, "me")] } },
            { "number": 4, "updatedAt": "2026-09-01", "reviewDecision": "CHANGES_REQUESTED", "reviewThreads": { "nodes": [] } },
            {},
        ] } });
        let r = rank_mine(&data);
        let order: Vec<u64> = r.as_array().unwrap().iter().map(|p| p["number"].as_u64().unwrap()).collect();
        assert_eq!(order, vec![4, 2, 1, 3]);
        assert_eq!((r[1]["waiting"].as_u64(), r[1]["unresolved"].as_u64()), (Some(1), Some(2)));
        assert_eq!(r[3]["waiting"].as_u64(), Some(0));
        assert!(r[0].get("reviewThreads").is_none());
    }

    #[test]
    fn scopes_pr_lists_to_one_repo() {
        assert_eq!(github_slug("git@github.com:acme/platform.git\n"), Some("acme/platform".into()));
        assert_eq!(github_slug("https://github.com/acme/platform"), Some("acme/platform".into()));
        assert_eq!(github_slug("https://gitlab.com/a/b.git"), None);
        assert_eq!(safe_slug("a/b\" OR x"), None);
        assert_eq!(safe_slug("my-org/my.repo_1"), Some("my-org/my.repo_1"));
        assert!(mine_query(" repo:a/b").contains("archived:false repo:a/b\""));
        assert!(mine_query("").contains("archived:false\""));
    }

    #[test]
    fn reads_owner_name_and_number_from_a_pr_url() {
        assert_eq!(pr_parts("https://github.com/acme/platform/pull/482"), Some(("acme".into(), "platform".into(), 482)));
        assert_eq!(pr_parts("https://github.com/acme/platform/pull/482/files"), Some(("acme".into(), "platform".into(), 482)));
        assert_eq!(pr_parts("acme/platform#12"), None);
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
