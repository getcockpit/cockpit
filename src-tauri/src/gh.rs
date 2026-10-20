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

// Open PRs in one repo that aren't mine, with when I last reviewed each and its newest commit (MR-81),
// and each reviewer's standing APPROVED / CHANGES_REQUESTED, to find mine (MR-173).
fn unreviewed_query(repo: &str) -> String {
    format!("query {{ viewer {{ login }} search(query: \"is:pr is:open -author:@me archived:false repo:{repo}\", type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ number title url updatedAt isDraft author {{ login }} repository {{ nameWithOwner }} headRefOid viewerLatestReview {{ submittedAt state }} latestOpinionatedReviews(first: 100) {{ nodes {{ state author {{ login }} }} }} commits(last: 1) {{ nodes {{ commit {{ committedDate }} }} }} }} }} }} }}")
}

/// The `reviewNote` of a PR I reviewed, with no commits since, that still lacks my approval (MR-173).
pub const NOT_APPROVED: &str = "not approved yet";

/// What's worth reviewing in one repo: PRs I've never reviewed, PRs with commits newer than my
/// last review, and PRs I reviewed with nothing new since that still lack my approval (a "ship
/// it" left as a comment, MR-173) (`reviewNote` says which). My standing opinion is my entry in
/// `latestOpinionatedReviews`: a later comment doesn't undo an approval, and changes requested
/// leave the ball with the author, so both drop out. Drafts are skipped, as auto-review does
/// (MR-72). Changed-since-my-review first (I'm mid-review there), then never reviewed, then not
/// approved yet; newest first in each.
pub fn rank_unreviewed(data: &serde_json::Value) -> serde_json::Value {
    let me = data["viewer"]["login"].as_str().unwrap_or_default();
    let mut prs: Vec<(u8, serde_json::Value)> = data["search"]["nodes"].as_array().cloned().unwrap_or_default().into_iter()
        .filter(|p| p["number"].is_number() && p["isDraft"] != true)
        .filter_map(|mut p| {
            let mine = p["viewerLatestReview"]["submittedAt"].as_str().map(str::to_owned);
            let last = p["commits"]["nodes"][0]["commit"]["committedDate"].as_str().map(str::to_owned);
            let opinion = p["latestOpinionatedReviews"]["nodes"].as_array()
                .and_then(|rs| rs.iter().find(|r| !me.is_empty() && r["author"]["login"].as_str() == Some(me)))
                .and_then(|r| r["state"].as_str().map(str::to_owned));
            let (tier, note) = match (mine, last.clone()) {
                (None, _) => (1, "not reviewed yet"),
                // RFC 3339 UTC timestamps from GitHub compare correctly as strings.
                (Some(r), Some(c)) if c > r => (0, "new changes since your review"),
                _ if matches!(opinion.as_deref(), Some("APPROVED" | "CHANGES_REQUESTED")) => return None,
                _ => (2, NOT_APPROVED),
            };
            p["reviewNote"] = note.into();
            // What a recurring review dedupes on (MR-171): the head it would review, and when it was made.
            p["headSha"] = p["headRefOid"].clone();
            p["lastCommitAt"] = last.into();
            let o = p.as_object_mut()?;
            o.remove("viewerLatestReview");
            o.remove("latestOpinionatedReviews");
            o.remove("commits");
            o.remove("headRefOid");
            Some((tier, p))
        })
        .collect();
    prs.sort_by(|(ta, a), (tb, b)| ta.cmp(tb).then_with(|| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str())));
    prs.into_iter().map(|(_, p)| p).collect::<Vec<_>>().into()
}

/// Every PR in `repo` that needs my review, ranked (`rank_unreviewed`), from the folder `cwd`.
pub fn unreviewed(cwd: &str, repo: &str) -> Result<serde_json::Value, String> {
    let repo = safe_slug(repo).ok_or_else(|| format!("not a GitHub repo: {repo}"))?;
    Ok(rank_unreviewed(&gh(cwd, &["api", "graphql", "-f", &format!("query={}", unreviewed_query(repo))])?["data"]))
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

/// `review`: open PRs waiting for my review; in one repo, every PR I haven't reviewed, that
/// changed since my review (MR-81) or that I reviewed without approving (MR-173). `address`: my open PRs, the ones with something to
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
        "review" => match repo {
            Some(r) => unreviewed(&cwd, r),
            None => gh(&cwd, &["search", "prs", "--review-requested=@me", "--state=open", "--limit", "20", "--json", "number,title,url,author,repository,updatedAt,isDraft"]),
        },
        "address" => {
            let q = mine_query(&repo.map(|r| format!(" repo:{r}")).unwrap_or_default());
            Ok(rank_mine(&gh(&cwd, &["api", "graphql", "-f", &format!("query={q}")])?["data"]))
        }
        _ => Err(format!("unknown mode {mode}")),
    }
}

/// The repos auto-review also watches (MR-170): trimmed, a `github.com/` prefix or `.git` dropped,
/// each one a safe `owner/name`, duplicates (any case) kept once, in the order given.
pub fn clean_watched(repos: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for r in repos {
        let r = r.trim().trim_start_matches("https://").trim_start_matches("github.com/").trim_end_matches('/').trim_end_matches(".git");
        let slug = safe_slug(r).ok_or_else(|| format!("not a GitHub repo (owner/name): {r}"))?;
        if !out.iter().any(|o| o.eq_ignore_ascii_case(slug)) { out.push(slug.to_owned()); }
    }
    Ok(out)
}

/// Settings → Sessions → Watched repos (MR-170): validates the whole list and logs it as
/// `ui.auto_review_repos_set`, which the reducer reads. Returns the list as stored.
#[tauri::command(async)]
pub fn auto_review_repos_set(app: AppHandle, repos: Vec<String>) -> Result<Vec<String>, String> {
    let repos = clean_watched(&repos)?;
    crate::eventlog::record(&app, None, "ui.auto_review_repos_set", &serde_json::json!({ "repos": repos }), None).ok_or("event log unavailable")?;
    Ok(repos)
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
        .iter()
        // Each part joined on its own: "go/github.com" as one part keeps its "/" on Windows.
        .map(|b| b.split('/').fold(home.to_path_buf(), |p, c| p.join(c)))
        .flat_map(|b| [b.join(owner).join(name), b.join(name)]).collect();
    cands.push(home.join(name));
    cands.extend(extra.iter().map(std::path::PathBuf::from));
    cands.into_iter().find(|d| d.is_dir() && origin_matches(d, slug)).map(|d| d.display().to_string())
}

/// The local clone for a PR (URL or owner/name), or null when it can't be found.
// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn pr_repo(spec: String) -> Option<String> {
    let slug = repo_slug(&spec)?;
    // Windows has no HOME: the profile folder is the same place.
    let home = std::path::PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default());
    let recent: Vec<String> = crate::folders::recent_folders().into_iter().map(|f| f.path).collect();
    find_clone(&home, &slug, &recent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_repo_from_any_pr_spec() {
        assert_eq!(repo_slug("https://github.com/acme/shop/pull/482"), Some("acme/shop".into()));
        assert_eq!(repo_slug("acme/shop#12"), Some("acme/shop".into()));
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
    fn keeps_prs_i_havent_reviewed_or_that_changed_since() {
        let pr = |n: u64, updated: &str, draft: bool, mine: Option<&str>, last: &str| json!({ "number": n, "updatedAt": updated, "isDraft": draft,
            "viewerLatestReview": mine.map(|m| json!({ "submittedAt": m })), "commits": { "nodes": [{ "commit": { "committedDate": last } }] } });
        let data = json!({ "search": { "nodes": [
            pr(1, "2026-10-05", false, None, "2026-10-04T10:00:00Z"),
            pr(2, "2026-10-03", false, Some("2026-10-01T10:00:00Z"), "2026-10-02T10:00:00Z"),
            pr(3, "2026-10-06", false, Some("2026-10-02T10:00:00Z"), "2026-10-01T10:00:00Z"),
            pr(4, "2026-10-07", true, None, "2026-10-07T10:00:00Z"),
            pr(5, "2026-10-08", false, None, "2026-10-08T10:00:00Z"),
            {},
        ] } });
        let r = rank_unreviewed(&data);
        let order: Vec<u64> = r.as_array().unwrap().iter().map(|p| p["number"].as_u64().unwrap()).collect();
        assert_eq!(order, vec![2, 5, 1, 3]);
        assert_eq!(r[0]["reviewNote"], "new changes since your review");
        assert_eq!(r[1]["reviewNote"], "not reviewed yet");
        assert_eq!(r[3]["reviewNote"], NOT_APPROVED);
        assert!(r[0].get("commits").is_none() && r[0].get("viewerLatestReview").is_none());
        assert_eq!(r[0]["lastCommitAt"], "2026-10-02T10:00:00Z");
        assert!(unreviewed_query("a/b").contains("headRefOid"));
        assert!(unreviewed_query("a/b").contains("-author:@me archived:false repo:a/b\""));
    }

    #[test]
    fn surfaces_prs_i_reviewed_but_havent_approved() {
        // Reviewed by me on 10-02, newest commit 10-01: nothing new since my review (MR-173).
        let pr = |n: u64, updated: &str, mine: &str, opinions: serde_json::Value| json!({ "number": n, "updatedAt": updated, "isDraft": false,
            "url": format!("https://github.com/acme/shop/pull/{n}"), "headRefOid": format!("sha{n}"),
            "viewerLatestReview": { "submittedAt": "2026-10-02T10:00:00Z", "state": mine }, "latestOpinionatedReviews": { "nodes": opinions },
            "commits": { "nodes": [{ "commit": { "committedDate": "2026-10-01T10:00:00Z" } }] } });
        let op = |by: &str, state: &str| json!({ "state": state, "author": { "login": by } });
        let data = json!({ "viewer": { "login": "me" }, "search": { "nodes": [
            // Only a "ship it" comment: surfaced, last tier.
            pr(1, "2026-10-03", "COMMENTED", json!([])),
            // Approved: done.
            pr(2, "2026-10-04", "APPROVED", json!([op("me", "APPROVED")])),
            // Approved, then a later comment: still approved.
            pr(3, "2026-10-05", "COMMENTED", json!([op("me", "APPROVED")])),
            // Changes requested: the ball is with the author.
            pr(4, "2026-10-06", "CHANGES_REQUESTED", json!([op("me", "CHANGES_REQUESTED")])),
            // Someone else approved, I only commented: still needs mine.
            pr(5, "2026-10-07", "COMMENTED", json!([op("dana", "APPROVED")])),
            // Never reviewed: ahead of the not-approved ones.
            json!({ "number": 6, "updatedAt": "2026-10-01", "isDraft": false, "viewerLatestReview": null,
                "commits": { "nodes": [{ "commit": { "committedDate": "2026-10-01T09:00:00Z" } }] } }),
        ] } });
        let r = rank_unreviewed(&data);
        let order: Vec<u64> = r.as_array().unwrap().iter().map(|p| p["number"].as_u64().unwrap()).collect();
        assert_eq!(order, vec![6, 5, 1]);
        assert_eq!((r[1]["reviewNote"].as_str(), r[2]["reviewNote"].as_str()), (Some(NOT_APPROVED), Some(NOT_APPROVED)));
        assert_eq!((r[2]["headSha"].as_str(), r[2]["lastCommitAt"].as_str()), (Some("sha1"), Some("2026-10-01T10:00:00Z")));
        assert!(r[2].get("latestOpinionatedReviews").is_none());
        let q = unreviewed_query("a/b");
        assert!(q.contains("viewer { login }") && q.contains("viewerLatestReview { submittedAt state }") && q.contains("latestOpinionatedReviews(first: 100)"));
    }

    #[test]
    fn scopes_pr_lists_to_one_repo() {
        assert_eq!(github_slug("git@github.com:acme/shop.git\n"), Some("acme/shop".into()));
        assert_eq!(github_slug("https://github.com/acme/shop"), Some("acme/shop".into()));
        assert_eq!(github_slug("https://gitlab.com/a/b.git"), None);
        assert_eq!(safe_slug("a/b\" OR x"), None);
        assert_eq!(safe_slug("my-org/my.repo_1"), Some("my-org/my.repo_1"));
        assert!(mine_query(" repo:a/b").contains("archived:false repo:a/b\""));
        assert!(mine_query("").contains("archived:false\""));
    }

    #[test]
    fn cleans_the_watched_repo_list() {
        let v = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(clean_watched(&v(&[" globex/forge ", "https://github.com/acme/shop.git", "Globex/Forge"])), Ok(v(&["globex/forge", "acme/shop"])));
        assert_eq!(clean_watched(&[]), Ok(vec![]));
        assert!(clean_watched(&v(&["globex/forge", "forge"])).is_err());
        assert!(clean_watched(&v(&["a/b\" OR x"])).is_err());
        assert!(clean_watched(&v(&["a/b/c"])).is_err());
    }

    #[test]
    fn reads_owner_name_and_number_from_a_pr_url() {
        assert_eq!(pr_parts("https://github.com/acme/shop/pull/482"), Some(("acme".into(), "shop".into(), 482)));
        assert_eq!(pr_parts("https://github.com/acme/shop/pull/482/files"), Some(("acme".into(), "shop".into(), 482)));
        assert_eq!(pr_parts("acme/platform#12"), None);
    }

    #[test]
    fn finds_a_clone_only_by_its_origin() {
        let home = std::env::temp_dir().join(format!("mr-home-{}", ulid::Ulid::new()));
        let right = home.join("go").join("github.com").join("acme").join("shop");
        let wrong = home.join("code").join("shop");
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
