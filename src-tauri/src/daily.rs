//! The daily-driver counter (decision 10): v1 is done after 7 days of real work without starting
//! Claude Code outside the app. Claude Code writes every session to
//! ~/.claude/projects/<folder>/<session-id>.jsonl; any session created that day which the app did
//! not start counts as an outside session.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Default, Clone)]
pub struct Day {
    pub date: String,
    pub app_sessions: u32,
    pub outside_sessions: u32,
}

#[derive(Debug, Serialize, PartialEq, Default)]
pub struct DailyDriver {
    pub days: Vec<Day>,
    /// Consecutive days up to today with app use and no outside sessions (today counts if clean).
    pub streak: u32,
    pub goal: u32,
}

/// Session files under `projects_dir` created at `ms` timestamps, keyed by session id.
pub fn scan(projects_dir: &Path) -> Vec<(String, i64)> {
    let mut out = vec![];
    let Ok(folders) = std::fs::read_dir(projects_dir) else { return out };
    for folder in folders.flatten() {
        // Self-tests and probes run in temp folders; they're never "work".
        let name = folder.file_name().to_string_lossy().to_string();
        if name.contains("mr-selftest") || name.contains("mr-probe") {
            continue;
        }
        let Ok(files) = std::fs::read_dir(folder.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = p.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else { continue };
            let Ok(meta) = f.metadata() else { continue };
            let t = meta.created().or_else(|_| meta.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
            if let Some(t) = t {
                out.push((id, t.as_millis() as i64));
            }
        }
    }
    out
}

fn day_of(ms: i64) -> String {
    // Local calendar day; chrono-free: shift by the local UTC offset reported by `date`.
    let offset = local_offset_secs();
    let days = (ms / 1000 + offset).div_euclid(86_400);
    civil_from_days(days)
}

fn local_offset_secs() -> i64 {
    std::process::Command::new("date")
        .arg("+%z")
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_owned();
            let sign = if s.starts_with('-') { -1 } else { 1 };
            let d: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
            if d.len() == 4 {
                Some(sign * (d[..2].parse::<i64>().ok()? * 3600 + d[2..].parse::<i64>().ok()? * 60))
            } else {
                None
            }
        })
        .unwrap_or(0)
}

// Howard Hinnant's days-from-civil inverse.
fn civil_from_days(z: i64) -> String {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

/// Builds the per-day table and streak from session files and the ids the app started.
pub fn compute(files: &[(String, i64)], app_ids: &HashSet<String>, now_ms: i64, goal: u32) -> DailyDriver {
    let mut days: BTreeMap<String, Day> = BTreeMap::new();
    for (id, ms) in files {
        let date = day_of(*ms);
        let d = days.entry(date.clone()).or_insert_with(|| Day { date, ..Default::default() });
        if app_ids.contains(id) { d.app_sessions += 1 } else { d.outside_sessions += 1 }
    }
    let mut streak = 0;
    let mut cursor = now_ms;
    loop {
        let date = day_of(cursor);
        match days.get(&date) {
            Some(d) if d.app_sessions > 0 && d.outside_sessions == 0 => streak += 1,
            None if cursor == now_ms => {} // nothing yet today: don't break the streak
            _ => break,
        }
        cursor -= 86_400_000;
        if streak > 365 {
            break;
        }
    }
    DailyDriver { days: days.into_values().rev().take(14).collect(), streak, goal }
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn daily_driver(app: tauri::AppHandle, log: tauri::State<'_, crate::eventlog::EventLog>) -> Result<DailyDriver, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let mut files = scan(&Path::new(&home).join(".claude/projects"));
    // Isolated workspaces keep their own transcripts (decision 24).
    if let Ok(rd) = std::fs::read_dir(crate::selfbuild::data_dir(&app).join("workspaces")) {
        for ws in rd.flatten() {
            files.extend(scan(&ws.path().join("claude/projects")));
        }
    }
    let app_ids: HashSet<String> = log
        .list_kind("sidecar.session_started")
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|e| e.payload["sdk_session_id"].as_str().map(str::to_owned))
        .collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64;
    Ok(compute(&files, &app_ids, now, 7))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;

    #[test]
    fn streak_counts_clean_days_and_breaks_on_outside_sessions() {
        let now = 1_791_590_000_000; // a fixed "today"
        let app: HashSet<String> = ["a1", "a2", "a3"].iter().map(|s| s.to_string()).collect();
        let files = vec![
            ("a1".to_string(), now),
            ("a2".to_string(), now - DAY),
            ("x1".to_string(), now - 2 * DAY), // outside session two days ago breaks the streak there
            ("a3".to_string(), now - 2 * DAY),
        ];
        let r = compute(&files, &app, now, 7);
        assert_eq!(r.streak, 2);
        assert_eq!(r.days.iter().find(|d| d.outside_sessions == 1).map(|d| d.app_sessions), Some(1));
    }

    #[test]
    fn an_empty_today_does_not_break_yesterdays_streak() {
        let now = 1_791_590_000_000;
        let app: HashSet<String> = ["a1"].iter().map(|s| s.to_string()).collect();
        let r = compute(&[("a1".into(), now - DAY)], &app, now, 7);
        assert_eq!(r.streak, 1);
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), "1970-01-01");
        assert_eq!(civil_from_days(20_735), "2026-10-09");
    }
}
