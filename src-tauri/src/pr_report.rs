//! PR report: a repo's recent pull requests, fetched through the user's `gh`, cached on disk, and
//! turned into the numbers that matter once agents write most PRs. Deterministic, no Claude usage.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const DAY_MS: i64 = 86_400_000;
const PAGE: u32 = 50;
const FILES_PER_PR: u32 = 100;

/// Phase 1: which PRs changed, newest first (cheap, 100 a page).
const LIST_QUERY: &str = "query($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequests(first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { number updatedAt } } } }";

/// Phase 2: the details of up to `DETAIL_BATCH` PRs by number, as aliases in one query.
fn detail_query(numbers: &[u64]) -> String {
    let fields = format!("number title url createdAt updatedAt mergedAt closedAt isDraft additions deletions changedFiles body author {{ login }} reviews(first: 50) {{ nodes {{ state submittedAt author {{ login }} }} }} files(first: {FILES_PER_PR}) {{ nodes {{ path }} }}");
    let parts: String = numbers.iter().map(|n| format!(" p{n}: pullRequest(number: {n}) {{ {fields} }}")).collect();
    format!("query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{{parts} }} }}")
}

const DETAIL_BATCH: usize = 20;
const PARALLEL: usize = 4;

/// Milliseconds since the epoch from GitHub's `2025-01-02T03:04:05Z`.
pub fn ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000)
}

fn t(v: &Value) -> Option<i64> {
    v.as_str().and_then(ts)
}

/// Test and fixture code, docs and lockfiles don't count when matching a fix to the PR it fixes.
pub fn is_source(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    let name = p.rsplit('/').next().unwrap_or(&p);
    let test_dir = p.split('/').any(|seg| matches!(seg, "test" | "tests" | "__tests__" | "spec" | "specs" | "fixtures" | "__snapshots__" | "testdata" | "e2e"));
    let test_name = name.contains(".test.") || name.contains(".spec.") || name.contains("_test.") || name.starts_with("test_");
    let doc = [".md", ".mdx", ".txt", ".rst", ".png", ".jpg", ".svg", ".snap"].iter().any(|e| name.ends_with(e));
    let lock = name.ends_with(".lock") || name == "package-lock.json" || name == "pnpm-lock.yaml" || name == "bun.lockb" || name == "go.sum";
    !(test_dir || test_name || doc || lock)
}

/// A follow-up fix or revert, by its title: `fix: …`, `fix(x): …`, `Fix …`, `hotfix`, `Revert "…"`.
pub fn is_fix(title: &str) -> bool {
    let t = title.trim().to_ascii_lowercase();
    let first: String = t.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    matches!(first.as_str(), "fix" | "fixes" | "fixed" | "fixing" | "hotfix" | "bugfix" | "revert" | "reverts")
        || t.contains("revert \"")
        || t.starts_with("[fix]")
}

/// Written with Claude Code, by its PR body's usual footer or co-author line.
pub fn is_agent(body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    b.contains("claude code") || b.contains("claude.com/claude-code") || b.contains("claude.ai/code") || b.contains("co-authored-by: claude")
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = v.len() / 2;
    Some(if v.len() % 2 == 0 { (v[m - 1] + v[m]) / 2.0 } else { v[m] })
}

fn pct(n: usize, d: usize) -> Option<f64> {
    (d > 0).then(|| (n as f64 * 1000.0 / d as f64).round() / 10.0)
}

struct Pr<'a> {
    v: &'a Value,
    number: u64,
    created: i64,
    merged: Option<i64>,
    lines: i64,
    author: String,
    agent: bool,
    files: HashSet<String>,
}

fn band(lines: i64) -> &'static str {
    if lines < 200 { "under 200 lines" } else if lines < 1000 { "200–999 lines" } else { "1,000+ lines" }
}

const BANDS: [&str; 3] = ["under 200 lines", "200–999 lines", "1,000+ lines"];

/// The report for PRs created in `[now - weeks, now]`. `prs` are GitHub's PR nodes (any window).
pub fn compute(prs: &[Value], weeks: u32, now: i64) -> Value {
    let since = now - weeks as i64 * 7 * DAY_MS;
    let all: Vec<Pr> = prs.iter().filter_map(|v| {
        let created = t(&v["createdAt"])?;
        let files = v["files"]["nodes"].as_array().map(|a| a.iter().filter_map(|f| f["path"].as_str()).filter(|p| is_source(p)).map(str::to_owned).collect()).unwrap_or_default();
        Some(Pr {
            v, number: v["number"].as_u64()?, created, merged: t(&v["mergedAt"]),
            lines: v["additions"].as_i64().unwrap_or(0) + v["deletions"].as_i64().unwrap_or(0),
            author: v["author"]["login"].as_str().unwrap_or("ghost").to_owned(),
            agent: is_agent(v["body"].as_str().unwrap_or_default()),
            files,
        })
    }).collect();
    let win: Vec<&Pr> = all.iter().filter(|p| p.created >= since && p.created <= now && !p.v["isDraft"].as_bool().unwrap_or(false)).collect();
    let merged: Vec<&Pr> = win.iter().copied().filter(|p| p.merged.is_some()).collect();

    // Volume per week, oldest first.
    let mut opened = vec![0u32; weeks as usize];
    let mut merged_w = vec![0u32; weeks as usize];
    let week = |at: i64| (((at - since) / (7 * DAY_MS)) as usize).min(weeks as usize - 1);
    for p in &win {
        opened[week(p.created)] += 1;
    }
    for p in all.iter().filter_map(|p| p.merged).filter(|m| *m >= since && *m <= now) {
        merged_w[week(p)] += 1;
    }

    // Reviews by people other than the author.
    let reviews = |p: &Pr| -> Vec<(String, String, i64)> {
        p.v["reviews"]["nodes"].as_array().map(|a| a.iter().filter_map(|r| {
            let who = r["author"]["login"].as_str()?.to_owned();
            let state = r["state"].as_str()?.to_owned();
            let at = t(&r["submittedAt"])?;
            (who != p.author && state != "PENDING").then_some((who, state, at))
        }).collect()).unwrap_or_default()
    };
    let approved = |p: &Pr| reviews(p).iter().any(|(_, s, at)| s == "APPROVED" && p.merged.is_none_or(|m| *at <= m));
    let changes = |p: &Pr| reviews(p).iter().any(|(_, s, _)| s == "CHANGES_REQUESTED");

    // Fixed again within 7 days: a later merged fix/revert PR touching the same source files.
    let fixes: Vec<&Pr> = all.iter().filter(|p| p.merged.is_some() && is_fix(p.v["title"].as_str().unwrap_or_default())).collect();
    let fixed_by = |p: &Pr| -> Option<u64> {
        let m = p.merged?;
        fixes.iter().filter(|q| q.number != p.number).find(|q| {
            let qm = q.merged.unwrap_or(0);
            qm > m && qm <= m + 7 * DAY_MS && !q.files.is_disjoint(&p.files)
        }).map(|q| q.number)
    };
    // Only PRs whose 7 days have passed can be judged.
    let judged: Vec<&Pr> = merged.iter().copied().filter(|p| p.merged.is_some_and(|m| m + 7 * DAY_MS <= now)).collect();
    let pairs: Vec<(u64, u64)> = judged.iter().filter_map(|p| fixed_by(p).map(|q| (p.number, q))).collect();
    let fixed: HashSet<u64> = pairs.iter().map(|(p, _)| *p).collect();

    let rates = |set: &[&Pr]| {
        let m: Vec<&Pr> = set.iter().copied().filter(|p| p.merged.is_some()).collect();
        let j: Vec<&Pr> = m.iter().copied().filter(|p| judged.iter().any(|x| x.number == p.number)).collect();
        json!({
            "prs": set.len(),
            "merged": m.len(),
            "approved_pct": pct(m.iter().filter(|p| approved(p)).count(), m.len()),
            "changes_requested_pct": pct(set.iter().filter(|p| changes(p)).count(), set.len()),
            "fixed_again_pct": pct(j.iter().filter(|p| fixed.contains(&p.number)).count(), j.len()),
            "judged": j.len(),
        })
    };

    let by_band: Vec<Value> = BANDS.iter().map(|b| {
        let set: Vec<&Pr> = win.iter().copied().filter(|p| band(p.lines) == *b).collect();
        json!({ "band": b, "rates": rates(&set) })
    }).collect();

    // Review load.
    let mut per_reviewer: BTreeMap<String, usize> = BTreeMap::new();
    let mut first_review_h = vec![];
    for p in &win {
        let rs = reviews(p);
        for (who, _, _) in &rs {
            *per_reviewer.entry(who.clone()).or_default() += 1;
        }
        if let Some(first) = rs.iter().map(|(_, _, at)| *at).min() {
            first_review_h.push((first - p.created).max(0) as f64 / 3_600_000.0);
        }
    }
    let total_reviews: usize = per_reviewer.values().sum();
    let mut reviewers: Vec<(String, usize)> = per_reviewer.into_iter().collect();
    reviewers.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut authors: HashMap<&str, usize> = HashMap::new();
    for p in &win {
        *authors.entry(p.author.as_str()).or_default() += 1;
    }
    let mut authors: Vec<(&str, usize)> = authors.into_iter().collect();
    authors.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));

    let agent: Vec<&Pr> = win.iter().copied().filter(|p| p.agent).collect();
    let human: Vec<&Pr> = win.iter().copied().filter(|p| !p.agent).collect();
    let url_of = |n: u64| all.iter().find(|p| p.number == n).and_then(|p| p.v["url"].as_str()).unwrap_or_default().to_owned();

    json!({
        "weeks": weeks,
        "since": since,
        "until": now,
        "volume": { "opened": opened, "merged": merged_w, "opened_total": win.len(), "merged_total": merged.len() },
        "size": {
            "median_lines": median(merged.iter().map(|p| p.lines as f64).collect()),
            "median_files": median(merged.iter().map(|p| p.v["changedFiles"].as_f64().unwrap_or(0.0)).collect()),
            "over_1000_pct": pct(merged.iter().filter(|p| p.lines >= 1000).count(), merged.len()),
        },
        "rates": rates(&win),
        "by_band": by_band,
        "fixed_again": pairs.iter().map(|(p, q)| json!({ "pr": p, "pr_url": url_of(*p), "fix": q, "fix_url": url_of(*q) })).collect::<Vec<_>>(),
        "review_load": {
            "reviews": total_reviews,
            "top_share_pct": reviewers.first().and_then(|(_, n)| pct(*n, total_reviews)),
            "median_first_review_h": median(first_review_h).map(|h| (h * 10.0).round() / 10.0),
            "reviewers": reviewers.iter().map(|(l, n)| json!({ "login": l, "reviews": n })).collect::<Vec<_>>(),
        },
        "authors": authors.iter().map(|(l, n)| json!({ "login": l, "prs": n })).collect::<Vec<_>>(),
        "agent": { "share_pct": pct(agent.len(), win.len()), "agent": rates(&agent), "other": rates(&human) },
    })
}

// ---- fetching and the cache -----------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Cache {
    /// The newest `updatedAt` seen: a re-run stops paging once it reaches it.
    newest: String,
    /// The oldest window fetched in full, so a longer window fetches again.
    since: i64,
    prs: BTreeMap<u64, Value>,
}

fn cache_path(dir: &Path, repo: &str) -> PathBuf {
    dir.join("pr-report").join(format!("{}.json", repo.replace('/', "-")))
}

fn graphql(cwd: &str, query: &str, vars: &[String]) -> Result<Value, String> {
    let q = format!("query={query}");
    let mut args = vec!["api", "graphql", "-f", q.as_str()];
    for v in vars {
        args.extend([if v.starts_with("cursor=") { "-f" } else { "-F" }, v.as_str()]);
    }
    let out = crate::gh::run(cwd, &args)?;
    if let Some(e) = out["errors"].as_array().and_then(|a| a.first()) {
        return Err(e["message"].as_str().unwrap_or("GitHub error").to_owned());
    }
    Ok(out)
}

fn fetch(cwd: &str, repo: &str, since: i64, cache: &mut Cache) -> Result<usize, String> {
    let (owner, name) = repo.split_once('/').ok_or("repo must be owner/name")?;
    let ids = [format!("owner={owner}"), format!("name={name}")];
    let full = cache.since > since || cache.prs.is_empty();
    // Phase 1: the PRs updated since the window opened (or since the last run), newest first.
    let mut changed: Vec<u64> = vec![];
    let mut cursor: Option<String> = None;
    'pages: for _ in 0..100 {
        let mut vars = ids.to_vec();
        if let Some(c) = &cursor {
            vars.push(format!("cursor={c}"));
        }
        let out = graphql(cwd, LIST_QUERY, &vars)?;
        let page = &out["data"]["repository"]["pullRequests"];
        for n in page["nodes"].as_array().cloned().unwrap_or_default() {
            let updated = n["updatedAt"].as_str().unwrap_or_default();
            if t(&n["updatedAt"]).is_some_and(|u| u < since) || (!full && updated <= cache.newest.as_str()) {
                break 'pages;
            }
            let Some(num) = n["number"].as_u64() else { continue };
            if cache.prs.get(&num).is_none_or(|c| c["updatedAt"].as_str() != Some(updated)) {
                changed.push(num);
            }
        }
        if !page["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
            break;
        }
        cursor = page["pageInfo"]["endCursor"].as_str().map(str::to_owned);
    }
    // Phase 2: their details, in batches, a few queries at a time.
    let batches: Vec<Vec<u64>> = changed.chunks(DETAIL_BATCH).map(<[u64]>::to_vec).collect();
    let mut fetched = 0;
    for group in batches.chunks(PARALLEL) {
        let results: Vec<Result<Value, String>> = std::thread::scope(|s| {
            let hs: Vec<_> = group.iter().map(|b| { let ids = &ids; s.spawn(move || graphql(cwd, &detail_query(b), ids)) }).collect();
            hs.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("fetch failed".into()))).collect()
        });
        for r in results {
            let out = r?;
            for (_, n) in out["data"]["repository"].as_object().cloned().unwrap_or_default() {
                let Some(num) = n["number"].as_u64() else { continue };
                let updated = n["updatedAt"].as_str().unwrap_or_default().to_owned();
                if updated > cache.newest {
                    cache.newest = updated;
                }
                cache.prs.insert(num, n);
                fetched += 1;
            }
        }
    }
    if full {
        cache.since = since;
    }
    Ok(fetched)
}

/// The report for `repo` (owner/name) over the last `weeks` weeks, fetched with `gh` in `cwd`.
pub fn report(data_dir: &Path, cwd: &str, repo: &str, weeks: u32, now: i64) -> Result<Value, String> {
    let weeks = weeks.clamp(1, 26);
    let since = now - weeks as i64 * 7 * DAY_MS;
    let path = cache_path(data_dir, repo);
    let mut cache: Cache = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let started = std::time::Instant::now();
    let fetched = fetch(cwd, repo, since, &mut cache)?;
    // Keep two windows' worth, so a slightly longer window doesn't refetch everything.
    let keep = now - 2 * 26 * 7 * DAY_MS;
    cache.prs.retain(|_, v| t(&v["updatedAt"]).is_none_or(|u| u >= keep));
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, serde_json::to_vec(&cache).unwrap_or_default());
    let prs: Vec<Value> = cache.prs.values().cloned().collect();
    let mut r = compute(&prs, weeks, now);
    r["repo"] = json!(repo);
    r["fetched"] = json!(fetched);
    r["took_ms"] = json!(started.elapsed().as_millis() as u64);
    Ok(r)
}

#[tauri::command(async)]
pub fn pr_report(app: AppHandle, cwd: String, repo: String, weeks: Option<u32>) -> Result<Value, String> {
    let repo = crate::gh::repo_slug(&repo).ok_or("Not a GitHub repo (owner/name)")?;
    let now = crate::browser::now_ms();
    let r = report(&crate::selfbuild::data_dir(&app), &cwd, &repo, weeks.unwrap_or(8), now)?;
    crate::eventlog::record(&app, None, "ui.pr_report", &json!({ "repo": repo, "weeks": r["weeks"], "prs": r["volume"]["opened_total"], "took_ms": r["took_ms"] }), Some("pr_report"));
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(n: u64, title: &str, created: &str, merged: Option<&str>, lines: i64, files: &[&str], reviews: &[(&str, &str, &str)], body: &str) -> Value {
        json!({
            "number": n, "title": title, "url": format!("https://github.com/o/r/pull/{n}"), "createdAt": created, "updatedAt": merged.unwrap_or(created),
            "mergedAt": merged, "isDraft": false, "additions": lines, "deletions": 0, "changedFiles": files.len(), "body": body,
            "author": { "login": "alice" },
            "reviews": { "nodes": reviews.iter().map(|(who, s, at)| json!({ "author": { "login": who }, "state": s, "submittedAt": at })).collect::<Vec<_>>() },
            "files": { "nodes": files.iter().map(|p| json!({ "path": p })).collect::<Vec<_>>() },
        })
    }

    #[test]
    fn parses_github_timestamps() {
        assert_eq!(ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(ts("2026-11-24T12:00:00Z"), Some(1_795_521_600_000));
        assert_eq!(ts("2000-03-01T00:00:01Z"), Some(951_868_801_000));
        assert_eq!(ts("bad"), None);
    }

    #[test]
    fn tells_source_from_tests_docs_and_locks() {
        assert!(is_source("src/auth/login.ts"));
        assert!(!is_source("src/auth/login.test.ts"));
        assert!(!is_source("tests/login.rs"));
        assert!(!is_source("docs/README.md"));
        assert!(!is_source("Cargo.lock"));
        assert!(!is_source("ui/src/__snapshots__/x.ts"));
    }

    #[test]
    fn recognises_fixes_and_reverts_by_title() {
        for t in ["fix: login loop", "fix(auth): token", "Fix the redirect", "Revert \"Add cache\"", "hotfix: prod", "[fix] thing"] {
            assert!(is_fix(t), "{t}");
        }
        for t in ["Add login", "feat: prefix fixtures", "Refactor fixer module", "fixture cleanup"] {
            assert!(!is_fix(t), "{t}");
        }
    }

    #[test]
    fn computes_the_numbers_on_a_known_fixture() {
        let now = ts("2026-03-01T00:00:00Z").unwrap();
        let prs = vec![
            // Big agent PR, approved, then fixed 2 days later on the same file.
            pr(1, "Add billing", "2026-01-10T00:00:00Z", Some("2026-01-11T00:00:00Z"), 1500, &["src/billing.rs", "src/billing_test.rs"], &[("bob", "APPROVED", "2026-01-10T06:00:00Z")], "🤖 Generated with [Claude Code](https://claude.com/claude-code)"),
            pr(2, "fix: billing rounding", "2026-01-12T00:00:00Z", Some("2026-01-13T00:00:00Z"), 20, &["src/billing.rs"], &[("bob", "APPROVED", "2026-01-12T01:00:00Z")], ""),
            // Changes requested, then approved; a later fix touches only a test file: not a follow-up.
            pr(3, "Add search", "2026-01-20T00:00:00Z", Some("2026-01-22T00:00:00Z"), 300, &["src/search.rs"], &[("carol", "CHANGES_REQUESTED", "2026-01-20T12:00:00Z"), ("bob", "APPROVED", "2026-01-21T00:00:00Z")], ""),
            pr(4, "fix: flaky search test", "2026-01-23T00:00:00Z", Some("2026-01-23T05:00:00Z"), 10, &["tests/search.rs"], &[], ""),
            // Merged without approval; a fix more than 7 days later doesn't count.
            pr(5, "Tweak config", "2026-02-01T00:00:00Z", Some("2026-02-01T01:00:00Z"), 50, &["src/config.rs"], &[], ""),
            pr(6, "fix config", "2026-02-15T00:00:00Z", Some("2026-02-15T01:00:00Z"), 5, &["src/config.rs"], &[], ""),
            // Outside the window (8 weeks before Mar 1 is Jan 4).
            pr(7, "Old", "2025-12-01T00:00:00Z", Some("2025-12-02T00:00:00Z"), 5, &["src/billing.rs"], &[], ""),
            // Open, not merged.
            pr(8, "WIP thing", "2026-02-20T00:00:00Z", None, 80, &["src/x.rs"], &[], ""),
        ];
        let r = compute(&prs, 8, now);
        assert_eq!(r["volume"]["opened_total"], 7);
        assert_eq!(r["volume"]["merged_total"], 6);
        assert_eq!(r["volume"]["opened"].as_array().unwrap().len(), 8);
        assert_eq!(r["rates"]["approved_pct"], 50.0); // 1, 2, 3 of 6 merged
        assert_eq!(r["rates"]["changes_requested_pct"], 14.3); // 3 of 7
        // Judged: merged at least 7 days before now (all 6); fixed: only #1 (by #2).
        assert_eq!(r["rates"]["fixed_again_pct"], 16.7);
        assert_eq!(r["fixed_again"][0]["pr"], 1);
        assert_eq!(r["fixed_again"][0]["fix"], 2);
        assert_eq!(r["size"]["over_1000_pct"], 16.7);
        assert_eq!(r["by_band"][2]["rates"]["fixed_again_pct"], 100.0);
        assert_eq!(r["agent"]["share_pct"], 14.3);
        assert_eq!(r["review_load"]["reviews"], 4);
        assert_eq!(r["review_load"]["reviewers"][0]["login"], "bob");
        assert_eq!(r["review_load"]["top_share_pct"], 75.0);
        // First reviews after 6h, 1h, 12h.
        assert_eq!(r["review_load"]["median_first_review_h"], 6.0);
    }

    #[test]
    fn an_empty_repo_reports_no_rates_rather_than_zero() {
        let r = compute(&[], 8, ts("2026-03-01T00:00:00Z").unwrap());
        assert_eq!(r["volume"]["opened_total"], 0);
        assert!(r["rates"]["approved_pct"].is_null());
        assert!(r["review_load"]["top_share_pct"].is_null());
    }
}

#[cfg(test)]
mod live {
    /// `MR_PR_REPO=owner/name cargo test pr_report::live -- --ignored --nocapture`: a real fetch, timed.
    #[test]
    #[ignore]
    fn live_report() {
        let repo = std::env::var("MR_PR_REPO").expect("MR_PR_REPO");
        let dir = std::env::temp_dir().join(format!("mr-pr-report-{}", std::process::id()));
        let now = crate::browser::now_ms();
        let r = super::report(&dir, ".", &repo, 8, now).expect("report");
        let r2 = super::report(&dir, ".", &repo, 8, now).expect("cached report");
        println!("first {} ms ({} PRs), cached {} ms ({} fetched)", r["took_ms"], r["volume"]["opened_total"], r2["took_ms"], r2["fetched"]);
        let mut short = r.clone();
        short["review_load"]["reviewers"] = serde_json::json!([]);
        short["authors"] = serde_json::json!([]);
        short["fixed_again"] = serde_json::json!(r["fixed_again"].as_array().map(|a| a.len()));
        println!("{}", serde_json::to_string_pretty(&short).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }
}
