//! Append-only event log (decision 3): everything that happens — agent events, user actions,
//! annotations, god-mode marks — is one immutable row with a ULID. State is rebuilt by replay.
//! House rules: no foreign keys, enums, CHECKs or literal DEFAULTs; explicit column lists.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
#[cfg(test)]
use rusqlite::OptionalExtension;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Event {
    pub id: String,
    pub session_id: Option<String>,
    pub kind: String,
    pub payload: serde_json::Value,
    pub anchor: Option<String>,
    pub created_at: i64,
    /// Which running copy of the app wrote it (`EventLog::origin`); None in rows from before MR-99.
    pub origin: Option<String>,
}

/// An `Event` as the UI receives it: the payload is the stored JSON text, sent as is.
#[derive(Debug, Serialize)]
pub struct WireEvent {
    pub id: String,
    pub session_id: Option<String>,
    pub kind: String,
    pub payload: Box<serde_json::value::RawValue>,
    pub anchor: Option<String>,
    pub created_at: i64,
    pub origin: Option<String>,
}

pub struct EventLog {
    conn: Mutex<Connection>,
    /// Monotonic within a millisecond, so id order is always append order.
    ids: Mutex<ulid::Generator>,
    /// This process's id. Several copies (dev, /Applications) share one log (MR-99), so every row
    /// says who wrote it and each copy can tell its own sessions from the others'.
    origin: String,
}

impl EventLog {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS events (
               id         TEXT PRIMARY KEY,
               session_id TEXT,
               kind       TEXT NOT NULL,
               payload    TEXT NOT NULL,
               anchor     TEXT,
               created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS events_session ON events (session_id, id);
             CREATE INDEX IF NOT EXISTS events_kind ON events (kind, id);",
        )?;
        let has_origin = conn.prepare("SELECT origin FROM events LIMIT 0").is_ok();
        if !has_origin {
            conn.execute_batch("ALTER TABLE events ADD COLUMN origin TEXT")?;
        }
        Ok(Self { conn: Mutex::new(conn), ids: Mutex::new(ulid::Generator::new()), origin: ulid::Ulid::new().to_string() })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Appends one event and returns it. ULIDs sort by time, so `id` order is event order.
    pub fn append(
        &self,
        session_id: Option<&str>,
        kind: &str,
        payload: &serde_json::Value,
        anchor: Option<&str>,
    ) -> rusqlite::Result<Event> {
        let id = self.ids.lock().unwrap().generate().unwrap_or_else(|_| ulid::Ulid::new());
        let created_at = id.timestamp_ms() as i64;
        let id = id.to_string();
        self.conn.lock().unwrap().execute(
            "INSERT INTO events (id, session_id, kind, payload, anchor, created_at, origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, session_id, kind, payload.to_string(), anchor, created_at, self.origin],
        )?;
        Ok(Event {
            id,
            session_id: session_id.map(str::to_owned),
            kind: kind.to_owned(),
            payload: payload.clone(),
            anchor: anchor.map(str::to_owned),
            created_at,
            origin: Some(self.origin.clone()),
        })
    }

    /// Events in order, optionally for one session and/or after a given id (for incremental replay).
    /// Every event of one kind, oldest first (cheap lookups that shouldn't read the whole log).
    pub fn list_kind(&self, kind: &str) -> rusqlite::Result<Vec<Event>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, session_id, kind, payload, anchor, created_at, origin FROM events WHERE kind = ?1 ORDER BY id")?;
        let rows = stmt.query_map(params![kind], row)?;
        rows.collect()
    }

    /// Every event whose kind starts with one of `prefixes`, oldest first (MR-162). Reads the kind
    /// index only: folding docs from the whole log took 7.8 s of every start in a debug build.
    pub fn list_prefixed(&self, prefixes: &[&str]) -> rusqlite::Result<Vec<Event>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, payload, anchor, created_at, origin FROM events
             WHERE kind >= ?1 AND kind < ?1 || char(1114111) ORDER BY id",
        )?;
        let mut out = Vec::new();
        for p in prefixes {
            out.extend(stmt.query_map(params![p], row)?.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    /// What a relaunch needs to resume sessions cut off mid-turn (MR-122): their requests, messages,
    /// starts and ends, and the `result` that closes each turn. Not the transcripts.
    pub fn list_turns(&self) -> rusqlite::Result<Vec<Event>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, payload, anchor, created_at, origin FROM events
             WHERE kind IN ('ui.session_requested', 'ui.message_sent', 'sidecar.session_started', 'sidecar.session_ended')
                OR (kind = 'sidecar.sdk' AND json_extract(payload, '$.message.type') = 'result')
             ORDER BY id",
        )?;
        let rows = stmt.query_map([], row)?;
        rows.collect()
    }

    pub fn list(&self, session_id: Option<&str>, after: Option<&str>, limit: i64) -> rusqlite::Result<Vec<Event>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, payload, anchor, created_at, origin FROM events
             WHERE (?1 IS NULL OR session_id = ?1) AND (?2 IS NULL OR id > ?2)
             ORDER BY id LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, after, limit], row)?;
        rows.collect()
    }

    /// What the UI replays (MR-162): payloads pass through as stored JSON, never parsed and
    /// re-serialized. With `skip_archived`, sessions that are archived now keep only their small
    /// rows: their transcripts (`sidecar.sdk`) and command lists were 99% of a 471 MB log, and the
    /// UI loads them when such a session is opened.
    pub fn list_wire(&self, session_id: Option<&str>, after: Option<&str>, limit: i64, skip_archived: bool) -> rusqlite::Result<Vec<WireEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, payload, anchor, created_at, origin FROM events
             WHERE (?1 IS NULL OR session_id = ?1) AND (?2 IS NULL OR id > ?2)
               AND (?4 = 0 OR session_id IS NULL OR kind NOT IN ('sidecar.sdk', 'sidecar.commands')
                    OR session_id NOT IN (SELECT session_id FROM events e
                      WHERE kind = 'ui.session_archived' AND id = (SELECT max(id) FROM events x
                        WHERE x.session_id = e.session_id AND x.kind IN ('ui.session_archived', 'ui.session_unarchived', 'ui.session_requested', 'sidecar.session_started'))))
             ORDER BY id LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, after, limit, skip_archived as i64], wire_row)?;
        rows.collect()
    }

    /// One session's full history with the app-wide rows interleaved (MR-162): enough to rebuild a
    /// session that was loaded without its transcript, since app-wide rows (workspace removal, app
    /// restarts) change sessions too.
    pub fn session_wire(&self, session_id: &str) -> rusqlite::Result<Vec<WireEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, payload, anchor, created_at, origin FROM events
             WHERE session_id = ?1 OR session_id IS NULL ORDER BY id",
        )?;
        let rows = stmt.query_map(params![session_id], wire_row)?;
        rows.collect()
    }

    /// Rows other copies of the app wrote since `since_ms` (MR-99). Another process can commit a
    /// row with an id older than ones already seen, so callers re-read a window and drop repeats.
    pub fn foreign_since(&self, since_ms: i64) -> rusqlite::Result<Vec<Event>> {
        let lower = ulid::Ulid::from_parts(since_ms.max(0) as u64, 0).to_string();
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, payload, anchor, created_at, origin FROM events
             WHERE id >= ?1 AND (origin IS NULL OR origin <> ?2) ORDER BY id",
        )?;
        let rows = stmt.query_map(params![lower, self.origin], row)?;
        rows.collect()
    }

    #[cfg(test)]
    pub fn last_id(&self) -> rusqlite::Result<Option<String>> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM events ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
            .optional()
    }
}

fn wire_row(r: &rusqlite::Row) -> rusqlite::Result<WireEvent> {
    let payload: String = r.get(3)?;
    let null = || serde_json::value::RawValue::from_string("null".into()).unwrap();
    Ok(WireEvent {
        id: r.get(0)?,
        session_id: r.get(1)?,
        kind: r.get(2)?,
        payload: serde_json::value::RawValue::from_string(payload).unwrap_or_else(|_| null()),
        anchor: r.get(4)?,
        created_at: r.get(5)?,
        origin: r.get(6)?,
    })
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Event> {
    let payload: String = r.get(3)?;
    Ok(Event {
        id: r.get(0)?,
        session_id: r.get(1)?,
        kind: r.get(2)?,
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        anchor: r.get(4)?,
        created_at: r.get(5)?,
        origin: r.get(6)?,
    })
}

/// Appends an event and pushes the stored row to the UI on `mr-event`. Logging must never take
/// the app down, so a failed write is reported on stderr and the UI still gets the event.
pub fn record(
    app: &tauri::AppHandle,
    session_id: Option<&str>,
    kind: &str,
    payload: &serde_json::Value,
    anchor: Option<&str>,
) -> Option<Event> {
    use tauri::{Emitter, Manager};
    let log = app.try_state::<EventLog>()?;
    match log.append(session_id, kind, payload, anchor) {
        Ok(ev) => {
            if let Some(docs) = app.try_state::<crate::docs::Docs>() {
                docs.apply(&ev);
            }
            let _ = app.emit("mr-event", &ev);
            Some(ev)
        }
        Err(e) => {
            eprintln!("[eventlog] append failed for {kind}: {e}");
            None
        }
    }
}

/// UI actions (answers, notes, marks) go through here so they're logged like agent events.
#[tauri::command]
pub fn event_append(
    app: tauri::AppHandle,
    session_id: Option<String>,
    kind: String,
    payload: serde_json::Value,
    anchor: Option<String>,
) -> Result<Event, String> {
    if !kind.starts_with("ui.") {
        return Err("UI events must use a ui.* kind".into());
    }
    record(&app, session_id.as_deref(), &kind, &payload, anchor.as_deref()).ok_or_else(|| "event log unavailable".into())
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn events_list(
    log: tauri::State<'_, EventLog>,
    session_id: Option<String>,
    after: Option<String>,
    limit: Option<i64>,
    skip_archived: Option<bool>,
) -> Result<Vec<WireEvent>, String> {
    log.list_wire(session_id.as_deref(), after.as_deref(), limit.unwrap_or(5000), skip_archived.unwrap_or(false)).map_err(|e| e.to_string())
}

/// An archived session's full history, fetched when it's opened (MR-162).
#[tauri::command(async)]
pub fn events_session(log: tauri::State<'_, EventLog>, session_id: String) -> Result<Vec<WireEvent>, String> {
    log.session_wire(&session_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn appends_and_replays_in_order() {
        let log = EventLog::in_memory().unwrap();
        let a = log.append(Some("s1"), "sidecar.session_started", &json!({"sdk_session_id": "x"}), None).unwrap();
        let b = log.append(Some("s1"), "ui.permission_answered", &json!({"behavior": "allow"}), Some("card:p1")).unwrap();
        let _ = log.append(Some("s2"), "sidecar.sdk", &json!({"n": 1}), None).unwrap();
        let s1 = log.list(Some("s1"), None, 100).unwrap();
        assert_eq!(s1, vec![a.clone(), b.clone()]);
        assert!(a.id < b.id, "ULIDs must sort in append order");
        assert_eq!(log.list(None, None, 100).unwrap().len(), 3);
    }

    #[test]
    fn incremental_replay_after_an_id() {
        let log = EventLog::in_memory().unwrap();
        let a = log.append(None, "k", &json!(1), None).unwrap();
        let b = log.append(None, "k", &json!(2), None).unwrap();
        let c = log.append(None, "k", &json!(3), None).unwrap();
        let after_a: Vec<_> = log.list(None, Some(&a.id), 100).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(after_a, vec![b.id, c.id.clone()]);
        assert_eq!(log.last_id().unwrap(), Some(c.id));
    }

    #[test]
    fn wire_rows_carry_the_stored_payload_as_is() {
        let log = EventLog::in_memory().unwrap();
        log.append(Some("s"), "k", &json!({"a": [1, {"b": "x"}]}), Some("card:1")).unwrap();
        let rows = log.list_wire(None, None, 10, false).unwrap();
        assert_eq!(serde_json::to_value(&rows[0]).unwrap()["payload"], json!({"a": [1, {"b": "x"}]}));
        assert_eq!(serde_json::to_value(&rows[0]).unwrap()["anchor"], json!("card:1"));
    }

    #[test]
    fn skip_archived_drops_only_archived_transcripts() {
        let log = EventLog::in_memory().unwrap();
        let kinds = |rows: Vec<WireEvent>| rows.into_iter().map(|e| format!("{}:{}", e.session_id.unwrap_or_default(), e.kind)).collect::<Vec<_>>();
        for s in ["live", "old", "back", "resumed"] {
            log.append(Some(s), "ui.session_requested", &json!({}), None).unwrap();
            log.append(Some(s), "sidecar.sdk", &json!({"message": {"type": "user"}}), None).unwrap();
            log.append(Some(s), "sidecar.commands", &json!({"commands": []}), None).unwrap();
        }
        log.append(Some("old"), "ui.session_archived", &json!({}), None).unwrap();
        log.append(Some("back"), "ui.session_archived", &json!({}), None).unwrap();
        log.append(Some("back"), "ui.session_unarchived", &json!({}), None).unwrap();
        log.append(Some("resumed"), "ui.session_archived", &json!({}), None).unwrap();
        log.append(Some("resumed"), "sidecar.session_started", &json!({}), None).unwrap();
        log.append(None, "app.started", &json!({}), None).unwrap();
        let all = kinds(log.list_wire(None, None, 100, false).unwrap());
        let light = kinds(log.list_wire(None, None, 100, true).unwrap());
        assert!(!light.contains(&"old:sidecar.sdk".into()) && !light.contains(&"old:sidecar.commands".into()));
        assert!(light.contains(&"old:ui.session_requested".into()) && light.contains(&"old:ui.session_archived".into()));
        assert_eq!(all.len() - light.len(), 2, "only the archived session's transcript rows go: {light:?}");
        // Opening it reads its full history plus the app-wide rows, in order.
        let full = kinds(log.session_wire("old").unwrap());
        assert_eq!(full, vec!["old:ui.session_requested", "old:sidecar.sdk", "old:sidecar.commands", "old:ui.session_archived", ":app.started"]);
    }

    #[test]
    fn prefixed_and_turn_reads_pick_only_their_rows() {
        let log = EventLog::in_memory().unwrap();
        for k in ["doc.created", "sidecar.sdk", "ui.doc_note", "ui.docs_other", "ui.session_requested", "doc.block_set"] {
            log.append(Some("s"), k, &json!({"message": {"type": "assistant"}}), None).unwrap();
        }
        log.append(Some("s"), "sidecar.sdk", &json!({"message": {"type": "result"}}), None).unwrap();
        let kinds = |v: Vec<Event>| v.into_iter().map(|e| e.kind).collect::<Vec<_>>();
        assert_eq!(kinds(log.list_prefixed(&["doc.", "ui.doc_"]).unwrap()), ["doc.created", "ui.doc_note", "doc.block_set"]);
        let turns = log.list_turns().unwrap();
        assert_eq!(kinds(turns.clone()), ["ui.session_requested", "sidecar.sdk"]);
        assert_eq!(turns[1].payload["message"]["type"], "result");
    }

    #[test]
    fn ids_stay_in_append_order_within_one_millisecond() {
        let log = EventLog::in_memory().unwrap();
        let ids: Vec<String> = (0..500).map(|i| log.append(None, "k", &json!(i), None).unwrap().id).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn survives_reopen_from_disk() {
        let dir = std::env::temp_dir().join(format!("mr-eventlog-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.sqlite");
        let id = EventLog::open(&path).unwrap().append(Some("s"), "k", &json!({"a": 1}), None).unwrap().id;
        let again = EventLog::open(&path).unwrap().list(None, None, 10).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].id, id);
        assert_eq!(again[0].payload, json!({"a": 1}));
    }
}

