//! Append-only event log (decision 3): everything that happens — agent events, user actions,
//! annotations, god-mode marks — is one immutable row with a ULID. State is rebuilt by replay.
//! House rules: no foreign keys, enums, CHECKs or literal DEFAULTs; explicit column lists.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Event {
    pub id: String,
    pub session_id: Option<String>,
    pub kind: String,
    pub payload: serde_json::Value,
    pub anchor: Option<String>,
    pub created_at: i64,
}

pub struct EventLog {
    conn: Mutex<Connection>,
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
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Appends one event and returns it. ULIDs sort by time, so `id` order is event order.
    pub fn append(
        &self,
        session_id: Option<&str>,
        kind: &str,
        payload: &serde_json::Value,
        anchor: Option<&str>,
    ) -> rusqlite::Result<Event> {
        let id = ulid::Ulid::new();
        let created_at = id.timestamp_ms() as i64;
        let id = id.to_string();
        self.conn.lock().unwrap().execute(
            "INSERT INTO events (id, session_id, kind, payload, anchor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, session_id, kind, payload.to_string(), anchor, created_at],
        )?;
        Ok(Event {
            id,
            session_id: session_id.map(str::to_owned),
            kind: kind.to_owned(),
            payload: payload.clone(),
            anchor: anchor.map(str::to_owned),
            created_at,
        })
    }

    /// Events in order, optionally for one session and/or after a given id (for incremental replay).
    pub fn list(&self, session_id: Option<&str>, after: Option<&str>, limit: i64) -> rusqlite::Result<Vec<Event>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, payload, anchor, created_at FROM events
             WHERE (?1 IS NULL OR session_id = ?1) AND (?2 IS NULL OR id > ?2)
             ORDER BY id LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, after, limit], |r| {
            let payload: String = r.get(3)?;
            Ok(Event {
                id: r.get(0)?,
                session_id: r.get(1)?,
                kind: r.get(2)?,
                payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
                anchor: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
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

#[tauri::command]
pub fn events_list(
    log: tauri::State<'_, EventLog>,
    session_id: Option<String>,
    after: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Event>, String> {
    log.list(session_id.as_deref(), after.as_deref(), limit.unwrap_or(5000)).map_err(|e| e.to_string())
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
