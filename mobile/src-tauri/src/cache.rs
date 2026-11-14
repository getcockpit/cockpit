//! The phone's copy of the Mac's event log: rows exactly as the Mac streamed them, keyed by their
//! ULID, so `max(id)` is the cursor the next link resumes from. Same house rules as the Mac's log.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::value::RawValue;
use serde_json::Value;

pub struct Cache {
    conn: Mutex<Connection>,
}

fn raw(s: String) -> Box<RawValue> {
    RawValue::from_string(s).unwrap_or_else(|_| RawValue::from_string("null".into()).unwrap())
}

impl Cache {
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
               json       TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS events_session ON events (session_id, id);",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Stores rows the Mac sent and returns the ones that are new, in order. A full row replaces
    /// its `remote.truncated` stand-in (a fetch), and is returned too.
    pub fn insert(&self, events: &[Value]) -> rusqlite::Result<Vec<Value>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut fresh = Vec::new();
        for e in events {
            let (Some(id), Some(kind)) = (e["id"].as_str(), e["kind"].as_str()) else { continue };
            let old: Option<String> = tx.query_row("SELECT kind FROM events WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
            match old.as_deref() {
                None => {
                    tx.execute("INSERT INTO events (id, session_id, kind, json) VALUES (?1, ?2, ?3, ?4)", params![id, e["session_id"].as_str(), kind, e.to_string()])?;
                    fresh.push(e.clone());
                }
                Some("remote.truncated") if kind != "remote.truncated" => {
                    tx.execute("UPDATE events SET kind = ?2, json = ?3 WHERE id = ?1", params![id, kind, e.to_string()])?;
                    fresh.push(e.clone());
                }
                Some(_) => {}
            }
        }
        tx.commit()?;
        Ok(fresh)
    }

    pub fn cursor(&self) -> String {
        self.conn.lock().unwrap().query_row("SELECT max(id) FROM events", [], |r| r.get::<_, Option<String>>(0)).ok().flatten().unwrap_or_default()
    }

    pub fn list(&self, after: &str, limit: i64) -> rusqlite::Result<Vec<Box<RawValue>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT json FROM events WHERE id > ?1 ORDER BY id LIMIT ?2")?;
        let rows = stmt.query_map(params![after, limit], |r| r.get::<_, String>(0))?;
        rows.map(|r| r.map(raw)).collect()
    }

    /// One session's rows with the app-wide rows interleaved (as the Mac's `session_wire`).
    pub fn session(&self, session_id: &str) -> rusqlite::Result<Vec<Box<RawValue>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT json FROM events WHERE session_id = ?1 OR session_id IS NULL ORDER BY id")?;
        let rows = stmt.query_map(params![session_id], |r| r.get::<_, String>(0))?;
        rows.map(|r| r.map(raw)).collect()
    }

    /// The session of the newest row that has one.
    #[cfg(debug_assertions)]
    pub fn newest_session(&self) -> Option<String> {
        self.conn.lock().unwrap().query_row("SELECT session_id FROM events WHERE session_id IS NOT NULL ORDER BY id DESC LIMIT 1", [], |r| r.get(0)).ok()
    }

    pub fn wipe(&self) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute_batch("DELETE FROM events; VACUUM;")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_order_skips_repeats_and_fills_in_fetched_rows() {
        let c = Cache::in_memory().unwrap();
        let a = json!({ "id": "01A", "session_id": "s", "kind": "ui.message_sent", "payload": { "text": "hi" } });
        let b = json!({ "id": "01B", "session_id": "s", "kind": "remote.truncated", "payload": { "kind": "sidecar.sdk", "bytes": 99999 } });
        assert_eq!(c.insert(&[a.clone(), b.clone()]).unwrap().len(), 2);
        assert_eq!(c.insert(&[a.clone()]).unwrap().len(), 0, "a reconnect re-sending a row adds nothing");
        assert_eq!(c.cursor(), "01B");
        let full = json!({ "id": "01B", "session_id": "s", "kind": "sidecar.sdk", "payload": { "message": {} } });
        assert_eq!(c.insert(&[full]).unwrap().len(), 1);
        let rows: Vec<Value> = c.list("", 10).unwrap().iter().map(|r| serde_json::from_str(r.get()).unwrap()).collect();
        assert_eq!(rows[1]["kind"], "sidecar.sdk");
        assert_eq!(c.list("01A", 10).unwrap().len(), 1);
        assert_eq!(c.session("s").unwrap().len(), 2);
        c.wipe().unwrap();
        assert_eq!(c.cursor(), "");
    }
}
