//! Feature usage (MR-83): which buttons, views and shortcuts you actually use. Clicks are far too
//! many and too fine to replay, so they live in their own `usage` table next to the event log
//! instead of in `events`; the report also counts the `ui.*` actions the log already records.
//! Local only: nothing leaves the machine.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Item {
    /// `click` | `view` | `key`
    pub kind: String,
    /// The `data-mr` component, the screen or overlay, or the shortcut ("⌘⇧K").
    pub name: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub view: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Row {
    /// `click` | `view` | `key` | `action` (a `ui.*` event)
    pub kind: String,
    pub name: String,
    pub detail: String,
    /// In the asked-for window.
    pub count: i64,
    pub total: i64,
    pub last_at: i64,
}

pub struct Usage {
    conn: Mutex<Connection>,
}

impl Usage {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, anchor TEXT, created_at INTEGER NOT NULL);",
        )?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS usage (
               kind   TEXT NOT NULL,
               name   TEXT NOT NULL,
               detail TEXT NOT NULL,
               view   TEXT NOT NULL,
               at     INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS usage_at ON usage (at);",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn track(&self, items: &[Item]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("INSERT INTO usage (kind, name, detail, view, at) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for i in items {
                let cut = |s: &str| s.chars().take(80).collect::<String>();
                stmt.execute(params![cut(&i.kind), cut(&i.name), cut(&i.detail), cut(&i.view), i.at])?;
            }
        }
        tx.commit()
    }

    /// Every feature ever used, with its count since `since` (ms), most used first.
    pub fn report(&self, since: i64) -> rusqlite::Result<Vec<Row>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT kind, name, detail, SUM(at >= ?1), COUNT(*), MAX(at) FROM usage GROUP BY kind, name, detail
             UNION ALL
             SELECT 'action', substr(kind, 4), '', SUM(created_at >= ?1), COUNT(*), MAX(created_at) FROM events WHERE kind LIKE 'ui.%' GROUP BY kind
             ORDER BY 4 DESC, 5 DESC",
        )?;
        let rows = stmt.query_map(params![since], |r| {
            Ok(Row { kind: r.get(0)?, name: r.get(1)?, detail: r.get(2)?, count: r.get(3)?, total: r.get(4)?, last_at: r.get(5)? })
        })?;
        rows.collect()
    }
}

#[tauri::command(async)]
pub fn usage_track(usage: tauri::State<'_, Usage>, items: Vec<Item>) -> Result<(), String> {
    usage.track(&items).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn usage_report(usage: tauri::State<'_, Usage>, since: Option<i64>) -> Result<Vec<Row>, String> {
    usage.report(since.unwrap_or(0)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: &str, name: &str, detail: &str, at: i64) -> Item {
        Item { kind: kind.into(), name: name.into(), detail: detail.into(), view: "wall".into(), at }
    }

    #[test]
    fn counts_in_window_and_keeps_quiet_features() {
        let u = Usage::in_memory().unwrap();
        u.track(&[item("click", "Key", "Approve", 100), item("click", "Key", "Approve", 200), item("click", "Key", "Approve", 300), item("view", "settings", "", 50), item("key", "⌘K", "", 250)]).unwrap();
        u.conn.lock().unwrap().execute("INSERT INTO events (id, session_id, kind, payload, anchor, created_at) VALUES ('a', NULL, 'ui.model_set', '{}', NULL, 220), ('b', NULL, 'sidecar.sdk', '{}', NULL, 230)", []).unwrap();
        let rows = u.report(150).unwrap();
        let get = |k: &str, n: &str| rows.iter().find(|r| r.kind == k && r.name == n).cloned().unwrap();
        assert_eq!(rows[0].name, "Key");
        assert_eq!((get("click", "Key").count, get("click", "Key").total, get("click", "Key").last_at), (2, 3, 300));
        // Not used in the window, but still listed so it shows as gone quiet.
        assert_eq!((get("view", "settings").count, get("view", "settings").total), (0, 1));
        assert_eq!(get("action", "model_set").count, 1);
        assert!(rows.iter().all(|r| r.name != "sdk"));
        assert_eq!(rows.len(), 4);
    }

    #[test]
    fn long_labels_are_cut() {
        let u = Usage::in_memory().unwrap();
        u.track(&[item("click", "Key", &"x".repeat(500), 1)]).unwrap();
        assert_eq!(u.report(0).unwrap()[0].detail.len(), 80);
    }
}
