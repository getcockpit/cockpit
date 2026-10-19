//! Recurring sessions (MR-167): a saved prompt + folder + cadence that Cockpit starts by itself.
//! Schedules live in the event log only: `ui.schedule_set` upserts one, `ui.schedule_deleted`
//! removes it, `schedule.fired` / `schedule.failed` record each run. The state is a fold, read
//! fresh on every tick. A thread wakes every minute and starts a fresh session for each schedule
//! that's due, through the same path as a session you start (worktree, workspace, cap), in the
//! schedule's own permission mode. Missed runs (asleep, off, quit) catch up once.
//! Cadences are in local wall-clock time: `next_after` works on naive local times, so a slot in a
//! DST gap fires as soon as the clock passes it, and a repeated hour doesn't fire twice.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{Datelike, Local, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const KIND_PREFIXES: &[&str] = &["ui.schedule_", "schedule."];
/// A run starting this long after its slot is a catch-up (the machine slept, or Cockpit was off).
const LATE_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, PartialEq)]
pub enum Cadence {
    /// Every day at `at` (minutes after midnight).
    Daily { at: u32 },
    /// Monday to Friday at `at`.
    Weekdays { at: u32 },
    /// On these weekdays (1 = Monday … 7 = Sunday) at `at`.
    Weekly { at: u32, days: Vec<u32> },
    /// Every `every_h` hours, on the hours that line up with `at` (every 3 h from 09:00: 00, 03 … 21).
    Hourly { at: u32, every_h: u32 },
}

fn parse_at(v: &Value) -> Option<u32> {
    let s = v.as_str().unwrap_or("09:00");
    let (h, m) = s.split_once(':')?;
    let (h, m): (u32, u32) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

impl Cadence {
    /// `{kind: daily|weekdays|weekly|hourly, at: "HH:MM", days: [1..7], every_h}`.
    pub fn parse(v: &Value) -> Result<Cadence, String> {
        let at = parse_at(&v["at"]).ok_or("the time must be HH:MM")?;
        match v["kind"].as_str().unwrap_or("") {
            "daily" => Ok(Cadence::Daily { at }),
            "weekdays" => Ok(Cadence::Weekdays { at }),
            "weekly" => {
                let mut days: Vec<u32> = v["days"].as_array().into_iter().flatten().filter_map(|d| d.as_u64()).map(|d| d as u32).filter(|d| (1..=7).contains(d)).collect();
                days.sort_unstable();
                days.dedup();
                if days.is_empty() {
                    return Err("pick at least one day".into());
                }
                Ok(Cadence::Weekly { at, days })
            }
            "hourly" => {
                let every_h = v["every_h"].as_u64().unwrap_or(1) as u32;
                if !(1..=24).contains(&every_h) {
                    return Err("every 1 to 24 hours".into());
                }
                Ok(Cadence::Hourly { at, every_h })
            }
            k => Err(format!("unknown cadence: {k}")),
        }
    }

    /// The slots of one day, in minutes after midnight, earliest first.
    fn slots(&self, weekday: u32) -> Vec<u32> {
        match self {
            Cadence::Daily { at } => vec![*at],
            Cadence::Weekdays { at } => if weekday <= 5 { vec![*at] } else { vec![] },
            Cadence::Weekly { at, days } => if days.contains(&weekday) { vec![*at] } else { vec![] },
            Cadence::Hourly { at, every_h } => {
                let step = every_h * 60;
                (0..).map(|k| at % step + k * step).take_while(|m| *m < 24 * 60).collect()
            }
        }
    }
}

/// The first slot strictly after `t`, in local wall-clock time.
pub fn next_after(c: &Cadence, t: NaiveDateTime) -> NaiveDateTime {
    let mut day = t.date();
    for _ in 0..9 {
        for m in c.slots(day.weekday().number_from_monday()) {
            let at = day.and_time(NaiveTime::from_hms_opt(m / 60, m % 60, 0).expect("valid slot"));
            if at > t {
                return at;
            }
        }
        day = day.succ_opt().expect("date in range");
    }
    unreachable!("every cadence has a slot within a week")
}

/// The slot that's due now, if any: the first one after the schedule was last run or changed.
pub fn due(c: &Cadence, since: NaiveDateTime, now: NaiveDateTime) -> Option<NaiveDateTime> {
    Some(next_after(c, since)).filter(|slot| *slot <= now)
}

/// A schedule as folded from the log.
#[derive(Debug, Clone)]
pub struct Schedule {
    pub id: String,
    /// The last `ui.schedule_set` payload: name, prompt, cwd, workspace, worktree, cadence, permission_mode, paused.
    pub def: Value,
    /// When it was last set (created, edited, paused or resumed), ms.
    pub set_at: i64,
    /// When it last ran (or failed to start), ms.
    pub last_run: Option<i64>,
    pub runs: Vec<Value>,
}

impl Schedule {
    pub fn paused(&self) -> bool {
        self.def["paused"].as_bool().unwrap_or(false)
    }
    pub fn name(&self) -> &str {
        self.def["name"].as_str().unwrap_or("Recurring session")
    }
    pub fn cadence(&self) -> Option<Cadence> {
        Cadence::parse(&self.def["cadence"]).ok()
    }
    fn since(&self) -> i64 {
        self.last_run.map_or(self.set_at, |r| r.max(self.set_at))
    }
}

/// Folds `ui.schedule_*` and `schedule.*` events (oldest first) into the schedules there are now.
pub fn fold(events: &[crate::eventlog::Event]) -> BTreeMap<String, Schedule> {
    let mut out: BTreeMap<String, Schedule> = BTreeMap::new();
    for ev in events {
        let Some(id) = ev.payload["id"].as_str() else { continue };
        match ev.kind.as_str() {
            "ui.schedule_set" => {
                let s = out.entry(id.to_owned()).or_insert_with(|| Schedule { id: id.to_owned(), def: Value::Null, set_at: 0, last_run: None, runs: vec![] });
                s.def = ev.payload.clone();
                s.set_at = ev.created_at;
            }
            "ui.schedule_deleted" => {
                out.remove(id);
            }
            "schedule.fired" | "schedule.failed" => {
                if let Some(s) = out.get_mut(id) {
                    s.last_run = Some(ev.created_at);
                    let mut run = ev.payload.clone();
                    run["at"] = ev.created_at.into();
                    run["ok"] = (ev.kind == "schedule.fired").into();
                    s.runs.push(run);
                }
            }
            _ => {}
        }
    }
    out
}

fn local(ms: i64) -> NaiveDateTime {
    Local.timestamp_millis_opt(ms).single().map(|t| t.naive_local()).unwrap_or_default()
}

fn to_ms(t: NaiveDateTime) -> i64 {
    Local.from_local_datetime(&t).earliest().or_else(|| Local.from_local_datetime(&(t + chrono::Duration::hours(1))).earliest()).map_or(0, |t| t.timestamp_millis())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn list(app: &AppHandle) -> BTreeMap<String, Schedule> {
    fold(&app.state::<crate::eventlog::EventLog>().list_prefixed(KIND_PREFIXES).unwrap_or_default())
}

/// Any schedule that would run: the window then hides on close and Cockpit starts at login.
pub fn any_active(app: &AppHandle) -> bool {
    list(app).values().any(|s| !s.paused())
}

/// Recurring runs started by this copy, until their first turn ends: session → schedule name.
#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, String>>);

/// Starts a run of `s` now. Returns the session id.
fn fire(app: &AppHandle, s: &Schedule, reason: &str, slot: Option<NaiveDateTime>) -> Result<String, String> {
    let d = &s.def;
    let started = crate::sidecar::Started { schedule: Some(s.id.clone()), permission_mode: d["permission_mode"].as_str().map(str::to_owned) };
    let res = crate::sidecar::start_with(
        app.clone(),
        app.state::<crate::sidecar::Sidecar>(),
        d["cwd"].as_str().unwrap_or_default().to_owned(),
        d["prompt"].as_str().unwrap_or_default().to_owned(),
        None,
        None,
        Some("blank".into()),
        Some(d["worktree"].as_bool().unwrap_or(true)),
        None,
        d["workspace"].as_str().map(str::to_owned),
        None,
        None,
        started,
    );
    let slot = slot.map(|t| t.format("%Y-%m-%dT%H:%M").to_string());
    match &res {
        Ok(session) => {
            crate::eventlog::record(app, Some(session), "schedule.fired", &json!({ "id": s.id, "session": session, "reason": reason, "slot": slot }), None);
            app.state::<Runs>().0.lock().unwrap().insert(session.clone(), s.name().to_owned());
        }
        Err(e) => {
            crate::eventlog::record(app, None, "schedule.failed", &json!({ "id": s.id, "reason": reason, "slot": slot, "error": e }), None);
        }
    }
    res
}

/// Claims a slot so only one running copy of Cockpit (dev, /Applications) starts it (MR-99).
fn claim(app: &AppHandle, id: &str, slot: NaiveDateTime) -> bool {
    let dir: PathBuf = crate::selfbuild::data_dir(app).join("schedules");
    let _ = std::fs::create_dir_all(&dir);
    std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(format!("{id}-{}", slot.format("%Y%m%d%H%M")))).is_ok()
}

/// One tick: starts every schedule that's due. At the cap, a due run waits for the next tick.
pub fn tick(app: &AppHandle) {
    let now_ms = now_ms();
    let now = local(now_ms);
    for s in list(app).values() {
        if s.paused() {
            continue;
        }
        let Some(c) = s.cadence() else { continue };
        let Some(slot) = due(&c, local(s.since()), now) else { continue };
        if crate::sidecar::at_cap(app) {
            return;
        }
        if !claim(app, &s.id, slot) {
            continue;
        }
        let reason = if now_ms - to_ms(slot) > LATE_MS { "catchup" } else { "due" };
        let _ = fire(app, s, reason, Some(slot));
    }
}

fn tick_every() -> Duration {
    Duration::from_millis(std::env::var("MR_SCHEDULE_TICK_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(60_000))
}

pub fn start(app: &AppHandle) {
    app.manage(Runs::default());
    let app = app.clone();
    std::thread::spawn(move || {
        // Let the sidecar come up before the first catch-up.
        std::thread::sleep(Duration::from_secs(5).min(tick_every()));
        loop {
            tick(&app);
            std::thread::sleep(tick_every());
        }
    });
}

/// A run's first turn ended: tell you (notification), whether or not Cockpit is in front.
pub fn on_turn_end(app: &AppHandle, session: &str, result: &Value) {
    let Some(runs) = app.try_state::<Runs>() else { return };
    let Some(name) = runs.0.lock().unwrap().remove(session) else { return };
    let failed = result["is_error"].as_bool().unwrap_or(false);
    let text = result["result"].as_str().unwrap_or_default();
    let body: String = text.chars().take(200).collect();
    let note = crate::notify::Note {
        key: format!("recurring:{session}"),
        session: Some(session.to_owned()),
        title: if failed { format!("↻ {name} failed") } else { format!("↻ {name} finished") },
        subtitle: "Recurring session".into(),
        body: if body.trim().is_empty() { "Open it in Cockpit.".into() } else { body },
        actions: vec![],
        reply: false,
    };
    let _ = crate::notify::notify(app.clone(), note);
}

fn validate(def: &Value, app: &AppHandle) -> Result<(), String> {
    if def["name"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Err("give it a name".into());
    }
    if def["prompt"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Err("the prompt is empty".into());
    }
    let cwd = crate::sidecar::expand_home(app, def["cwd"].as_str().unwrap_or_default());
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("not a folder: {cwd}"));
    }
    if let Some(m) = def["permission_mode"].as_str() && !crate::sidecar::PERMISSION_MODES.contains(&m) {
        return Err(format!("unknown permission mode: {m}"));
    }
    Cadence::parse(&def["cadence"]).map(|_| ())
}

/// Creates or updates a schedule; returns its id. Logged here, in the command that does it.
#[tauri::command]
pub fn schedule_set(app: AppHandle, schedule: Value) -> Result<String, String> {
    validate(&schedule, &app)?;
    let id = schedule["id"].as_str().filter(|s| !s.is_empty()).map(str::to_owned).unwrap_or_else(|| ulid::Ulid::new().to_string());
    let d = &schedule;
    let payload = json!({
        "id": id,
        "name": d["name"].as_str().unwrap_or_default().trim(),
        "prompt": d["prompt"],
        "cwd": d["cwd"],
        "workspace": d["workspace"].as_str().unwrap_or(crate::workspaces::PERSONAL),
        "worktree": d["worktree"].as_bool().unwrap_or(true),
        "cadence": d["cadence"],
        "permission_mode": d["permission_mode"].as_str().unwrap_or(crate::sidecar::PERMISSION_MODE),
        "paused": d["paused"].as_bool().unwrap_or(false),
        "from_session": d["from_session"],
    });
    crate::eventlog::record(&app, None, "ui.schedule_set", &payload, None);
    crate::background::refresh(&app);
    Ok(id)
}

#[tauri::command]
pub fn schedule_delete(app: AppHandle, id: String) -> Result<(), String> {
    crate::eventlog::record(&app, None, "ui.schedule_deleted", &json!({ "id": id }), None);
    crate::background::refresh(&app);
    Ok(())
}

/// Pauses or resumes every schedule (the tray's Pause all).
pub fn pause_all(app: &AppHandle, paused: bool) {
    for s in list(app).into_values().filter(|s| s.paused() != paused) {
        let mut def = s.def.clone();
        def["paused"] = paused.into();
        crate::eventlog::record(app, None, "ui.schedule_set", &def, None);
    }
    crate::background::refresh(app);
}

/// Run now: a run outside the cadence. Its next slot stays where it was.
#[tauri::command(async)]
pub fn schedule_run_now(app: AppHandle, id: String) -> Result<String, String> {
    let s = list(&app).remove(&id).ok_or("that schedule was deleted")?;
    fire(&app, &s, "manual", None)
}

/// When each schedule runs next (ms), for the Recurring overlay; paused ones are left out.
#[tauri::command]
pub fn schedules_next(app: AppHandle) -> HashMap<String, i64> {
    let now = local(now_ms());
    list(&app)
        .values()
        .filter(|s| !s.paused())
        .filter_map(|s| {
            let c = s.cadence()?;
            let next = due(&c, local(s.since()), now).unwrap_or_else(|| next_after(&c, local(s.since()).max(now)));
            Some((s.id.clone(), to_ms(next)))
        })
        .collect()
}

/// `MR_SELFTEST=schedule`: a schedule due a minute from now must start a session by itself.
pub fn selftest(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let dir = std::env::temp_dir().join(format!("mr-selftest-{}", ulid::Ulid::new()));
        let _ = std::fs::create_dir_all(&dir);
        let at = local(now_ms()) + chrono::Duration::minutes(1);
        let def = json!({
            "name": "Selftest digest",
            "prompt": "This is a UI test. Reply with exactly: SELFTEST DONE",
            "cwd": dir.display().to_string(),
            "worktree": false,
            "cadence": { "kind": "daily", "at": format!("{:02}:{:02}", at.hour(), at.minute()) },
            "permission_mode": "default",
        });
        if let Err(e) = schedule_set(app.clone(), def) {
            eprintln!("[selftest] schedule_set failed: {e}");
            std::process::exit(1);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn t(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap()
    }
    fn c(v: Value) -> Cadence {
        Cadence::parse(&v).unwrap()
    }

    // 2026-10-19 is a Monday.
    #[test]
    fn daily_is_today_if_still_ahead_else_tomorrow() {
        let d = c(json!({ "kind": "daily", "at": "09:00" }));
        assert_eq!(next_after(&d, t(2026, 10, 19, 8, 59)), t(2026, 10, 19, 9, 0));
        assert_eq!(next_after(&d, t(2026, 10, 19, 9, 0)), t(2026, 10, 20, 9, 0));
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let w = c(json!({ "kind": "weekdays", "at": "09:00" }));
        assert_eq!(next_after(&w, t(2026, 10, 23, 10, 0)), t(2026, 10, 26, 9, 0)); // Fri → Mon
    }

    #[test]
    fn weekly_on_chosen_days() {
        let w = c(json!({ "kind": "weekly", "at": "08:30", "days": [3, 1] }));
        assert_eq!(next_after(&w, t(2026, 10, 19, 9, 0)), t(2026, 10, 21, 8, 30)); // Mon after → Wed
        assert_eq!(next_after(&w, t(2026, 10, 21, 9, 0)), t(2026, 10, 26, 8, 30)); // Wed after → next Mon
        assert!(Cadence::parse(&json!({ "kind": "weekly", "at": "08:30", "days": [] })).is_err());
    }

    #[test]
    fn hourly_lines_up_with_the_time_and_wraps_midnight() {
        let h = c(json!({ "kind": "hourly", "at": "09:15", "every_h": 3 }));
        assert_eq!(next_after(&h, t(2026, 10, 19, 9, 15)), t(2026, 10, 19, 12, 15));
        assert_eq!(next_after(&h, t(2026, 10, 19, 22, 0)), t(2026, 10, 20, 0, 15));
        assert!(Cadence::parse(&json!({ "kind": "hourly", "at": "00:00", "every_h": 0 })).is_err());
    }

    #[test]
    fn bad_times_are_refused() {
        assert!(Cadence::parse(&json!({ "kind": "daily", "at": "25:00" })).is_err());
        assert!(Cadence::parse(&json!({ "kind": "cron", "at": "09:00" })).is_err());
    }

    #[test]
    fn due_once_however_many_slots_were_missed() {
        let d = c(json!({ "kind": "daily", "at": "09:00" }));
        // Last ran Friday, the machine was off all weekend: one catch-up, for Saturday's slot.
        let since = t(2026, 10, 16, 9, 1);
        let now = t(2026, 10, 19, 7, 0);
        assert_eq!(due(&d, since, now), Some(t(2026, 10, 17, 9, 0)));
        // After that run, nothing more until today 09:00.
        assert_eq!(due(&d, now, now), None);
        assert_eq!(due(&d, now, t(2026, 10, 19, 9, 0)), Some(t(2026, 10, 19, 9, 0)));
    }

    #[test]
    fn dst_gap_and_repeat_in_wall_clock_time() {
        // A 02:30 slot on a spring-forward night (02:00 → 03:00) fires once the clock reads past it.
        let d = c(json!({ "kind": "daily", "at": "02:30" }));
        assert_eq!(due(&d, t(2026, 3, 28, 3, 0), t(2026, 3, 29, 3, 1)), Some(t(2026, 3, 29, 2, 30)));
        // Fall back (01:00–02:00 twice): having run at the first 01:30, the second 01:30 isn't due.
        let d = c(json!({ "kind": "daily", "at": "01:30" }));
        assert_eq!(due(&d, t(2026, 10, 25, 1, 30), t(2026, 10, 25, 1, 45)), None);
    }

    fn ev(kind: &str, payload: Value, at: i64) -> crate::eventlog::Event {
        crate::eventlog::Event { id: format!("{at:020}"), session_id: None, kind: kind.into(), payload, anchor: None, created_at: at, origin: None }
    }

    #[test]
    fn fold_upserts_deletes_and_records_runs() {
        let evs = vec![
            ev("ui.schedule_set", json!({ "id": "a", "name": "Digest", "paused": false }), 1),
            ev("ui.schedule_set", json!({ "id": "b", "name": "Standup" }), 2),
            ev("schedule.fired", json!({ "id": "a", "session": "s1", "reason": "due" }), 5),
            ev("ui.schedule_set", json!({ "id": "a", "name": "Digest 2", "paused": true }), 6),
            ev("schedule.failed", json!({ "id": "a", "error": "not a folder" }), 7),
            ev("ui.schedule_deleted", json!({ "id": "b" }), 8),
            ev("schedule.fired", json!({ "id": "b", "session": "s2" }), 9),
        ];
        let m = fold(&evs);
        assert_eq!(m.keys().collect::<Vec<_>>(), ["a"]);
        let a = &m["a"];
        assert_eq!(a.name(), "Digest 2");
        assert!(a.paused());
        assert_eq!((a.set_at, a.last_run), (6, Some(7)));
        assert_eq!(a.runs.len(), 2);
        assert_eq!(a.runs[0]["session"], "s1");
        assert_eq!(a.runs[1]["ok"], false);
        assert_eq!(a.since(), 7);
    }
}
