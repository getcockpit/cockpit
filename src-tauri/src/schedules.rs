//! Recurring sessions (MR-167): a saved prompt + folder + cadence that Cockpit starts by itself.
//! Schedules live in the event log only: `ui.schedule_set` upserts one, `ui.schedule_deleted`
//! removes it, `schedule.fired` / `schedule.failed` record each run. The state is a fold, read
//! fresh on every tick. A thread wakes every minute and starts a fresh session for each schedule
//! that's due, through the same path as a session you start (worktree, workspace, cap), in the
//! schedule's own permission mode. Missed runs (asleep, off, quit) catch up once.
//! Cadences are cron expressions (MR-169; the older daily/weekdays/weekly/hourly kinds parse as
//! their cron equivalent) in local wall-clock time: `next_after` works on naive local times, so a
//! slot in a DST gap fires as soon as the clock passes it, and a repeated hour doesn't fire twice.
//! A schedule may have a check (MR-169): a shell command run before each slot, for free. The run
//! starts only when it exits 0 and prints something other than what the last run was started with;
//! its output is appended to the prompt. Skipped slots aren't logged, only kept in memory (`Checks`).
//! Every schedule is a prompt (MR-175): reviewing each PR is a prompt with a gh check like any
//! other. Schedules saved in the older review mode (MR-171) become one on start (`migrated`), paused.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{Datelike, Local, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const KIND_PREFIXES: &[&str] = &["ui.schedule_", "schedule."];
/// A run starting this long after its slot is a catch-up (the machine slept, or Cockpit was off).
const LATE_MS: i64 = 5 * 60_000;
/// How long a check may run, and how much of its output is kept (and handed to Claude).
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
const CHECK_OUTPUT_CAP: u64 = 32 * 1024;
/// How far ahead a cadence must have a slot: "0 0 31 2 *" never runs and is refused.
const HORIZON_DAYS: i64 = 366 * 5;

/// A cadence: a 5-field cron expression (minute, hour, day of month, month, weekday) as bit sets.
#[derive(Debug, Clone, PartialEq)]
pub struct Cadence {
    pub expr: String,
    min: u64,
    hour: u32,
    dom: u32,
    month: u16,
    dow: u8,
    /// Cron's day rule: with both day fields restricted, a day matches either; else both.
    dom_any: bool,
    dow_any: bool,
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// One cron field (`*`, `5`, `1-5`, `*/10`, `9-17/2`, lists of these, month/day names) as a bit set.
fn field(s: &str, lo: u32, hi: u32, names: &[&str], what: &str) -> Result<u64, String> {
    let bad = || format!("bad {what}: {s}");
    let num = |t: &str| -> Result<u32, String> {
        let t = t.to_ascii_lowercase();
        let n = match names.iter().position(|n| *n == t) {
            Some(i) => i as u32 + if names.len() == 12 { 1 } else { 0 },
            None => t.parse().map_err(|_| bad())?,
        };
        (lo..=hi).contains(&n).then_some(n).ok_or_else(bad)
    };
    let mut bits = 0u64;
    for part in s.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, st)) => (r, st.parse::<u32>().ok().filter(|n| *n > 0).ok_or_else(bad)?),
            None => (part, 1),
        };
        let (a, b) = match range {
            "*" => (lo, hi),
            r => match r.split_once('-') {
                Some((a, b)) => (num(a)?, num(b)?),
                // `5/15` means from 5 to the end, every 15.
                None => { let a = num(r)?; (a, if part.contains('/') { hi } else { a }) }
            },
        };
        if a > b {
            return Err(bad());
        }
        for n in (a..=b).step_by(step as usize) {
            bits |= 1 << n;
        }
    }
    Ok(bits)
}

impl Cadence {
    /// A cron expression: `*/5 9-17 * * 1-5`.
    pub fn cron(expr: &str) -> Result<Cadence, String> {
        let f: Vec<&str> = expr.split_whitespace().collect();
        let [mi, h, dom, mo, dow] = f[..] else { return Err("a cron expression has 5 fields: minute hour day month weekday".into()) };
        let mut weekdays = field(dow, 0, 7, &WEEKDAYS, "weekday")?;
        if weekdays & (1 << 7) != 0 {
            weekdays = (weekdays | 1) & 0x7f; // 7 is Sunday too
        }
        let c = Cadence {
            expr: f.join(" "),
            min: field(mi, 0, 59, &[], "minute")?,
            hour: field(h, 0, 23, &[], "hour")? as u32,
            dom: field(dom, 1, 31, &[], "day of month")? as u32,
            month: field(mo, 1, 12, &MONTHS, "month")? as u16,
            dow: weekdays as u8,
            dom_any: dom.starts_with('*'),
            dow_any: dow.starts_with('*'),
        };
        let now = Local::now().naive_local();
        c.next(now).map(|_| c.clone()).ok_or_else(|| "that never runs".into())
    }

    /// `{kind: cron, expr}`, or the older `{kind: daily|weekdays|weekly|hourly, at: "HH:MM", days: [1..7], every_h}`.
    pub fn parse(v: &Value) -> Result<Cadence, String> {
        if v["kind"] == "cron" {
            return Cadence::cron(v["expr"].as_str().unwrap_or_default());
        }
        let at = parse_at(&v["at"]).ok_or("the time must be HH:MM")?;
        let (h, m) = (at / 60, at % 60);
        let expr = match v["kind"].as_str().unwrap_or("") {
            "daily" => format!("{m} {h} * * *"),
            "weekdays" => format!("{m} {h} * * 1-5"),
            "weekly" => {
                let mut days: Vec<u32> = v["days"].as_array().into_iter().flatten().filter_map(|d| d.as_u64()).map(|d| d as u32).filter(|d| (1..=7).contains(d)).collect();
                days.sort_unstable();
                days.dedup();
                if days.is_empty() {
                    return Err("pick at least one day".into());
                }
                format!("{m} {h} * * {}", days.iter().map(u32::to_string).collect::<Vec<_>>().join(","))
            }
            "hourly" => {
                let every_h = v["every_h"].as_u64().unwrap_or(1) as u32;
                if !(1..=24).contains(&every_h) {
                    return Err("every 1 to 24 hours".into());
                }
                format!("{m} {}-23/{every_h} * * *", h % every_h)
            }
            k => return Err(format!("unknown cadence: {k}")),
        };
        Cadence::cron(&expr)
    }

    fn day_matches(&self, d: chrono::NaiveDate) -> bool {
        let dom = self.dom & (1 << d.day()) != 0;
        let dow = self.dow & (1 << d.weekday().num_days_from_sunday()) != 0;
        self.month & (1 << d.month()) != 0 && if self.dom_any || self.dow_any { dom && dow } else { dom || dow }
    }

    /// The first slot strictly after `t`, within five years.
    fn next(&self, t: NaiveDateTime) -> Option<NaiveDateTime> {
        let mut day = t.date();
        for _ in 0..HORIZON_DAYS {
            if self.day_matches(day) {
                for h in (0..24).filter(|h| self.hour & (1 << h) != 0) {
                    for m in (0..60).filter(|m| self.min & (1 << m) != 0) {
                        let at = day.and_time(NaiveTime::from_hms_opt(h, m, 0).expect("valid slot"));
                        if at > t {
                            return Some(at);
                        }
                    }
                }
            }
            day = day.succ_opt()?;
        }
        None
    }
}

fn parse_at(v: &Value) -> Option<u32> {
    let s = v.as_str().unwrap_or("09:00");
    let (h, m) = s.split_once(':')?;
    let (h, m): (u32, u32) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// The first slot strictly after `t`, in local wall-clock time.
pub fn next_after(c: &Cadence, t: NaiveDateTime) -> NaiveDateTime {
    c.next(t).expect("parse refuses a cadence that never runs")
}

/// The slot that's due now, if any: the first one after the schedule was last run or changed.
pub fn due(c: &Cadence, since: NaiveDateTime, now: NaiveDateTime) -> Option<NaiveDateTime> {
    c.next(since).filter(|slot| *slot <= now)
}

/// What a check's run means for the slot.
#[derive(Debug, PartialEq)]
pub enum Gate {
    /// Start the run, with this output (trimmed, capped) and its hash.
    Fire { output: String, hash: String },
    /// Don't: `no` (exited non-zero), `same` (output as last run), `error` (didn't run, timed out).
    Skip { outcome: &'static str, error: Option<String> },
}

/// FNV-1a: a stable fingerprint of a check's output, to tell whether it changed.
fn fingerprint(s: &str) -> String {
    let h = s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{h:016x}")
}

/// The check's verdict: exit 0 with output other than `last` (the hash the last run started with) fires.
pub fn gate(res: Result<(i32, String, String), String>, last: Option<&str>) -> Gate {
    match res {
        Err(e) => Gate::Skip { outcome: "error", error: Some(e) },
        Ok((0, out, _)) => {
            let output = out.trim().to_owned();
            let hash = fingerprint(&output);
            if last == Some(hash.as_str()) { Gate::Skip { outcome: "same", error: None } } else { Gate::Fire { output, hash } }
        }
        // 126/127: the shell couldn't run it (not found, not executable): an error, not a "no".
        Ok((code @ (126 | 127), _, err)) => Gate::Skip { outcome: "error", error: Some(format!("exit {code}: {}", err.trim())) },
        Ok(_) => Gate::Skip { outcome: "no", error: None },
    }
}

fn shell(cmd: &str) -> std::process::Command {
    #[cfg(windows)]
    {
        // Verbatim, so quotes and `&` in the check reach cmd as typed; /S strips just the outer quotes.
        let mut c = crate::sys::cmd("cmd");
        c.args(["/S", "/C"]);
        std::os::windows::process::CommandExt::raw_arg(&mut c, format!("\"{cmd}\""));
        c
    }
    #[cfg(not(windows))]
    {
        // A login shell, so a check sees the PATH you'd have in a terminal (gh, git, brew).
        let sh = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let mut c = crate::sys::cmd(sh);
        c.args(["-lc", cmd]);
        c
    }
}

/// Runs a check in `cwd`: `(exit code, stdout, stderr)`, or why it didn't finish.
pub fn run_check(cmd: &str, cwd: &Path, timeout: Duration) -> Result<(i32, String, String), String> {
    use std::process::Stdio;
    let mut c = shell(cmd);
    c.current_dir(cwd).env_clear().envs(crate::selfbuild::child_env()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut c, 0);
    let mut child = c.spawn().map_err(|e| format!("couldn't start the check: {e}"))?;
    // Read both pipes on their own threads (keeping the first `cap` bytes) so a chatty check can't block.
    fn drain(r: Option<impl Read + Send + 'static>, cap: u64) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Some(mut r) = r {
            std::thread::spawn(move || {
                let mut b = Vec::new();
                let _ = r.by_ref().take(cap).read_to_end(&mut b);
                let _ = std::io::copy(&mut r, &mut std::io::sink());
                let _ = tx.send(b);
            });
        }
        rx
    }
    let (out, err) = (drain(child.stdout.take(), CHECK_OUTPUT_CAP), drain(child.stderr.take(), 4096));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if Instant::now() >= deadline {
            #[cfg(unix)]
            let _ = crate::sys::cmd("kill").args(["-9", &format!("-{}", child.id())]).status();
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("timed out after {} s", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let text = |rx: std::sync::mpsc::Receiver<Vec<u8>>| String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()).into_owned();
    Ok((status.code().unwrap_or(-1), text(out), text(err)))
}

/// The prompt a gated run starts with: yours, then what the check printed.
pub fn with_output(prompt: &str, check: &str, output: &str) -> String {
    let output = if output.is_empty() { "(no output)" } else { output };
    format!("{prompt}\n\nCheck output (`{check}`):\n```\n{output}\n```")
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
    /// Its check command, if it has one.
    pub fn check(&self) -> Option<&str> {
        self.def["check"].as_str().map(str::trim).filter(|c| !c.is_empty())
    }
    /// The output hash the last checked run started with.
    fn last_hash(&self) -> Option<&str> {
        self.runs.iter().rev().find(|r| r["ok"] == true && r["check_hash"].is_string()).and_then(|r| r["check_hash"].as_str())
    }
    /// The session of its last run that started.
    fn last_session(&self) -> Option<&str> {
        self.runs.iter().rev().find(|r| r["ok"] == true).and_then(|r| r["session"].as_str())
    }
}

/// The last check of each schedule, in memory only: skipped slots aren't logged (at every 5
/// minutes that would be 288 events a day), and losing the counts on a restart is fine.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Check {
    /// Slots up to here are handled (checked, skipped, or taken by another copy), ms.
    #[serde(skip)]
    since: i64,
    /// When it last checked, ms, and how that went: `checking`, `fired`, `busy`, `no`, `same`, `error`.
    pub at: i64,
    pub outcome: String,
    /// Slots skipped since the last run started.
    pub skipped: u32,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Checks(Mutex<HashMap<String, Check>>);

impl Checks {
    fn since(&self, id: &str) -> i64 {
        self.0.lock().unwrap().get(id).map_or(0, |c| c.since)
    }
    fn handled(&self, id: &str, now: i64) {
        self.0.lock().unwrap().entry(id.to_owned()).or_default().since = now;
    }
    fn note(&self, id: &str, now: i64, outcome: &str, error: Option<String>) {
        let mut m = self.0.lock().unwrap();
        let c = m.entry(id.to_owned()).or_default();
        c.at = now;
        c.outcome = outcome.to_owned();
        c.error = error;
        match outcome {
            "fired" => c.skipped = 0,
            "checking" => {}
            _ => c.skipped += 1,
        }
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

/// What a schedule saved in the older review mode (MR-171) starts as now (MR-175): a prompt that
/// reviews what a gh check lists. Paused, so you read the prompt before it runs unattended.
pub const REVIEW_PROMPT: &str = "Review each pull request in the check output below that is new or has new commits since the last run: run the /review skill on each, one at a time. Post nothing to GitHub; end with a short list of what each one needs from me.";
pub const REVIEW_CHECK: &str = r#"gh pr list --search "review-requested:@me" --json url,headRefOid"#;

/// The prompt schedule a review-mode one becomes, or `None` when it's a prompt schedule already.
pub fn migrated(def: &Value) -> Option<Value> {
    if def["mode"] != "review" {
        return None;
    }
    let mut d = def.clone();
    let o = d.as_object_mut()?;
    o.remove("mode");
    o.insert("prompt".into(), REVIEW_PROMPT.into());
    o.insert("check".into(), REVIEW_CHECK.into());
    o.insert("paused".into(), true.into());
    Some(d)
}

/// Logs the new definition of every review-mode schedule, so both folds (here, `reduce.ts`) see a
/// plain prompt schedule.
fn migrate(app: &AppHandle) {
    for s in list(app).values() {
        if let Some(def) = migrated(&s.def) {
            crate::eventlog::record(app, None, "ui.schedule_set", &def, None);
        }
    }
}

/// How a schedule's sessions start: tagged with it, unattended, in its own permission mode.
pub fn started_for(s: &Schedule) -> crate::sidecar::Started {
    crate::sidecar::Started {
        schedule: Some(s.id.clone()),
        permission_mode: s.def["permission_mode"].as_str().map(str::to_owned),
        unattended: true,
        parent: None,
    }
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
fn fire(app: &AppHandle, s: &Schedule, reason: &str, slot: Option<NaiveDateTime>, checked: Option<(String, String)>) -> Result<String, String> {
    let d = &s.def;
    let mut prompt = d["prompt"].as_str().unwrap_or_default().to_owned();
    if let (Some(check), Some((output, _))) = (s.check(), &checked) {
        prompt = with_output(&prompt, check, output);
    }
    let started = started_for(s);
    let res = crate::sidecar::start_with(
        app.clone(),
        app.state::<crate::sidecar::Sidecar>(),
        d["cwd"].as_str().unwrap_or_default().to_owned(),
        prompt,
        None,
        None,
        Some("blank".into()),
        Some(d["worktree"].as_bool().unwrap_or(true)),
        None,
        // Its workspace was deleted since: run in Personal rather than not at all.
        d["workspace"].as_str().filter(|w| crate::workspaces::exists(app, w)).map(str::to_owned),
        None,
        None,
        started,
    );
    let slot = slot.map(|t| t.format("%Y-%m-%dT%H:%M").to_string());
    if let Some(c) = app.try_state::<Checks>() {
        c.note(&s.id, now_ms(), "fired", None);
    }
    match &res {
        Ok(session) => {
            let mut payload = json!({ "id": s.id, "session": session, "reason": reason, "slot": slot });
            if let Some((_, hash)) = &checked {
                payload["check_hash"] = hash.clone().into();
            }
            crate::eventlog::record(app, Some(session), "schedule.fired", &payload, None);
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

/// Drops claims older than two days: a 5-minute cadence leaves 288 a day.
fn prune_claims(app: &AppHandle) {
    let dir: PathBuf = crate::selfbuild::data_dir(app).join("schedules");
    let old = std::time::SystemTime::now() - Duration::from_secs(2 * 24 * 3600);
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < old) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// The folder a schedule's check runs in.
fn check_dir(app: &AppHandle, s: &Schedule) -> PathBuf {
    PathBuf::from(crate::sidecar::expand_home(app, s.def["cwd"].as_str().unwrap_or_default()))
}

/// One tick: starts every schedule that's due. At the cap, a due run waits for the next tick.
/// A slot is handled once: claimed (by this copy or another), then skipped while the last run is
/// still mid-turn, else checked (on its own thread, so a slow check holds up no one) or started.
pub fn tick(app: &AppHandle) {
    prune_claims(app);
    let now_ms = now_ms();
    let now = local(now_ms);
    let checks = app.state::<Checks>();
    for s in list(app).values() {
        if s.paused() {
            continue;
        }
        let Some(c) = s.cadence() else { continue };
        let Some(slot) = due(&c, local(s.since().max(checks.since(&s.id))), now) else { continue };
        if crate::sidecar::at_cap(app) {
            return;
        }
        // Whatever happens next, the slots up to now are done: a skip isn't logged, so without
        // this the same slot would come back due every tick.
        checks.handled(&s.id, now_ms);
        if !claim(app, &s.id, slot) {
            continue;
        }
        let reason = if now_ms - to_ms(slot) > LATE_MS { "catchup" } else { "due" };
        if s.last_session().is_some_and(|p| crate::sidecar::mid_turn(app, p)) {
            checks.note(&s.id, now_ms, "busy", None);
            continue;
        }
        let Some(check) = s.check().map(str::to_owned) else {
            let _ = fire(app, s, reason, Some(slot), None);
            continue;
        };
        checks.note(&s.id, now_ms, "checking", None);
        let (app, s) = (app.clone(), s.clone());
        std::thread::spawn(move || match gate(run_check(&check, &check_dir(&app, &s), CHECK_TIMEOUT), s.last_hash()) {
            Gate::Fire { output, hash } => {
                let _ = fire(&app, &s, reason, Some(slot), Some((output, hash)));
            }
            Gate::Skip { outcome, error } => app.state::<Checks>().note(&s.id, self::now_ms(), outcome, error),
        });
    }
}

fn tick_every() -> Duration {
    Duration::from_millis(std::env::var("MR_SCHEDULE_TICK_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(60_000))
}

pub fn start(app: &AppHandle) {
    app.manage(Runs::default());
    app.manage(Checks::default());
    migrate(app);
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

/// A schedule's fields, without the folder (`validate` checks that).
pub fn check_def(def: &Value) -> Result<(), String> {
    if def["name"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Err("give it a name".into());
    }
    if def["prompt"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Err("the prompt is empty".into());
    }
    if let Some(m) = def["permission_mode"].as_str() && !crate::sidecar::PERMISSION_MODES.contains(&m) {
        return Err(format!("unknown permission mode: {m}"));
    }
    if !(def["check"].is_null() || def["check"].is_string()) {
        return Err("the check must be a command".into());
    }
    Cadence::parse(&def["cadence"]).map(|_| ())
}

fn validate(def: &Value, app: &AppHandle) -> Result<(), String> {
    check_def(def)?;
    let cwd = crate::sidecar::expand_home(app, def["cwd"].as_str().unwrap_or_default());
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("not a folder: {cwd}"));
    }
    Ok(())
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
        "check": d["check"].as_str().map(str::trim).filter(|c| !c.is_empty()),
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

/// Run now: a run outside the cadence. Its next slot stays where it was. A check still runs, so
/// the run gets its output, but whatever it says, the run starts.
#[tauri::command(async)]
pub fn schedule_run_now(app: AppHandle, id: String) -> Result<String, String> {
    let s = list(&app).remove(&id).ok_or("that schedule was deleted")?;
    let checked = s.check().and_then(|c| match gate(run_check(c, &check_dir(&app, &s), CHECK_TIMEOUT), None) {
        Gate::Fire { output, hash } => Some((output, hash)),
        Gate::Skip { .. } => None,
    });
    fire(&app, &s, "manual", None, checked)
}

/// The next runs of a cadence being edited (ms, up to five), or why it's not a cadence.
#[tauri::command]
pub fn schedule_preview(cadence: Value) -> Result<Vec<i64>, String> {
    let c = Cadence::parse(&cadence)?;
    let mut t = local(now_ms());
    Ok((0..5).map_while(|_| { t = c.next(t)?; Some(to_ms(t)) }).collect())
}

/// Each schedule's last check (in memory since Cockpit started), for the Recurring overlay.
#[tauri::command]
pub fn schedules_checks(app: AppHandle) -> HashMap<String, Check> {
    app.state::<Checks>().0.lock().unwrap().iter().filter(|(_, c)| !c.outcome.is_empty()).map(|(k, v)| (k.clone(), v.clone())).collect()
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

/// `MR_SELFTEST=schedule`: a schedule due a minute from now must start a session by itself, once
/// its check passes; one whose check fails must not.
pub fn selftest(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let dir = std::env::temp_dir().join(format!("mr-selftest-{}", ulid::Ulid::new()));
        let _ = std::fs::create_dir_all(&dir);
        let at = local(now_ms()) + chrono::Duration::minutes(1);
        let cadence = json!({ "kind": "cron", "expr": format!("{} {} * * *", at.minute(), at.hour()) });
        // It runs (its check passes, MR-169) with the check's output in its prompt; the second's
        // check says no, so it never starts.
        let defs = [
            json!({ "name": "Selftest digest", "prompt": "This is a UI test. Reply with exactly: SELFTEST DONE", "check": "echo SELFTEST-CHECK-OUTPUT" }),
            json!({ "name": "Selftest never", "prompt": "This must not run.", "check": "exit 1" }),
        ];
        for mut def in defs {
            def["cwd"] = dir.display().to_string().into();
            def["worktree"] = false.into();
            def["cadence"] = cadence.clone();
            def["permission_mode"] = "default".into();
            if let Err(e) = schedule_set(app.clone(), def) {
                eprintln!("[selftest] schedule_set failed: {e}");
                std::process::exit(1);
            }
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

    #[test]
    fn cron_steps_ranges_and_lists() {
        // Every 5 minutes in work hours, Monday to Friday.
        let w = Cadence::cron("*/5 9-17 * * 1-5").unwrap();
        assert_eq!(next_after(&w, t(2026, 10, 19, 9, 3)), t(2026, 10, 19, 9, 5));
        assert_eq!(next_after(&w, t(2026, 10, 19, 17, 55)), t(2026, 10, 20, 9, 0));
        assert_eq!(next_after(&w, t(2026, 10, 23, 18, 0)), t(2026, 10, 26, 9, 0)); // Fri evening → Mon
        let l = Cadence::cron("0,30 8 * * MON,thu").unwrap();
        assert_eq!(next_after(&l, t(2026, 10, 19, 8, 0)), t(2026, 10, 19, 8, 30));
        assert_eq!(next_after(&l, t(2026, 10, 19, 8, 30)), t(2026, 10, 22, 8, 0));
        // `a/n`: from a to the end; 7 is Sunday.
        let s = Cadence::cron("15/20 0 * * 7").unwrap();
        assert_eq!(next_after(&s, t(2026, 10, 19, 0, 0)), t(2026, 10, 25, 0, 15));
        assert_eq!(next_after(&s, t(2026, 10, 25, 0, 15)), t(2026, 10, 25, 0, 35));
    }

    #[test]
    fn cron_day_rule_is_or_when_both_days_are_restricted() {
        // The 1st of the month OR any Monday.
        let c = Cadence::cron("0 9 1 * 1").unwrap();
        assert_eq!(next_after(&c, t(2026, 10, 19, 10, 0)), t(2026, 10, 26, 9, 0));
        assert_eq!(next_after(&c, t(2026, 10, 27, 0, 0)), t(2026, 11, 1, 9, 0));
        // With one of them `*`, both must hold: the 1st, only in January.
        let y = Cadence::cron("0 0 1 jan *").unwrap();
        assert_eq!(next_after(&y, t(2026, 10, 19, 0, 0)), t(2027, 1, 1, 0, 0));
    }

    #[test]
    fn cron_refuses_nonsense() {
        for bad in ["* * * *", "60 * * * *", "* 24 * * *", "5-1 * * * *", "*/0 * * * *", "* * * foo *", "0 0 31 2 *"] {
            assert!(Cadence::cron(bad).is_err(), "{bad}");
        }
        assert!(Cadence::parse(&json!({ "kind": "cron", "expr": "*/10 * * * *" })).is_ok());
    }

    #[test]
    fn older_kinds_parse_as_cron() {
        assert_eq!(c(json!({ "kind": "weekdays", "at": "09:05" })).expr, "5 9 * * 1-5");
        assert_eq!(c(json!({ "kind": "weekly", "at": "08:30", "days": [7, 1] })).expr, "30 8 * * 1,7");
        assert_eq!(c(json!({ "kind": "hourly", "at": "09:15", "every_h": 3 })).expr, "15 0-23/3 * * *");
    }

    #[test]
    fn a_check_fires_on_exit_0_with_new_output() {
        let ok = |out: &str| Ok((0, out.to_owned(), String::new()));
        let Gate::Fire { output, hash } = gate(ok("  PR 12\n"), None) else { panic!("first run fires") };
        assert_eq!(output, "PR 12");
        assert_eq!(gate(ok("PR 12"), Some(&hash)), Gate::Skip { outcome: "same", error: None });
        assert!(matches!(gate(ok("PR 12\nPR 13"), Some(&hash)), Gate::Fire { .. }));
        assert_eq!(gate(Ok((1, "PR 12".into(), String::new())), None), Gate::Skip { outcome: "no", error: None });
        assert!(matches!(gate(Ok((127, String::new(), "gh: not found".into())), None), Gate::Skip { outcome: "error", error: Some(e) } if e.contains("not found")));
        assert!(matches!(gate(Err("timed out".into()), None), Gate::Skip { outcome: "error", .. }));
        assert_eq!(fingerprint("x"), fingerprint("x"));
        assert!(with_output("Review them", "gh pr list", "").ends_with("```\n(no output)\n```"));
    }

    fn sched(def: Value) -> Schedule {
        Schedule { id: "w".into(), def, set_at: 0, last_run: None, runs: vec![] }
    }

    #[test]
    fn every_schedule_needs_a_prompt() {
        let base = json!({ "name": "Watch", "prompt": "Do it", "cadence": { "kind": "cron", "expr": "*/5 9-17 * * 1-5" } });
        assert_eq!(check_def(&base), Ok(()));
        let mut empty = base.clone();
        empty["prompt"] = " ".into();
        assert_eq!(check_def(&empty), Err("the prompt is empty".into()));
        let runs = started_for(&sched(json!({ "permission_mode": "default" })));
        assert_eq!((runs.schedule.as_deref(), runs.permission_mode.as_deref(), runs.unattended), (Some("w"), Some("default"), true));
    }

    // MR-175: the older review mode becomes a paused prompt schedule with a gh check.
    #[test]
    fn review_mode_schedules_become_paused_prompt_schedules() {
        let old = json!({ "id": "w", "name": "Review each new PR", "mode": "review", "prompt": "", "cwd": "~/shop", "cadence": { "kind": "cron", "expr": "*/5 9-17 * * 1-5" }, "check": null, "paused": false });
        let new = migrated(&old).unwrap();
        assert!(new["mode"].is_null());
        assert_eq!((new["prompt"].as_str(), new["check"].as_str(), new["paused"].as_bool()), (Some(REVIEW_PROMPT), Some(REVIEW_CHECK), Some(true)));
        assert_eq!((&new["id"], &new["cwd"], &new["cadence"]), (&old["id"], &old["cwd"], &old["cadence"]));
        assert_eq!(check_def(&new), Ok(()));
        assert_eq!(migrated(&new), None);
        assert_eq!(migrated(&json!({ "name": "Digest", "prompt": "Do it" })), None);
    }

    #[cfg(unix)]
    #[test]
    fn checks_run_in_the_folder_and_time_out() {
        let dir = std::env::temp_dir().join(format!("mr-check-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("state"), "one").unwrap();
        let (code, out, _) = run_check("cat state", &dir, Duration::from_secs(10)).unwrap();
        assert_eq!((code, out.as_str()), (0, "one"));
        assert_eq!(run_check("exit 3", &dir, Duration::from_secs(10)).unwrap().0, 3);
        let start = Instant::now();
        assert!(run_check("sleep 30", &dir, Duration::from_millis(300)).unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(5));
        // Output beyond the cap is dropped without blocking the check.
        let (code, out, _) = run_check("head -c 100000 /dev/zero | tr '\\0' a", &dir, Duration::from_secs(10)).unwrap();
        assert_eq!((code, out.len() as u64), (0, CHECK_OUTPUT_CAP));
    }
}
