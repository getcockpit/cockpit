//! Cockpit Remote, the iPhone app (doc "Cockpit Remote", phase 2). The Mac stays the brain: this
//! app pairs once by the Mac's QR, keeps a local cache of the Mac's event log, and replays it with
//! the desktop's own reducer (`ui/src/state/reduce.ts`). To the UI it looks like the desktop core:
//! `events_list` / `events_session` read the cache and every new row arrives as `mr-event`.
//!
//! - `key.rs`: the phone's link key, in the iOS Keychain (this device only, Face ID or passcode).
//! - `cache.rs`: the event cache (SQLite, iOS Data Protection), wiped on Forget.
//! - `link.rs`: one task owns the link to the Mac: reconnects, fills the cache, sends commands.
//! - `gate.rs`: a fresh Face ID before approvals, answers and session starts leave the phone.

mod cache;
mod gate;
mod key;
mod link;

use serde_json::Value;
use tauri::Manager;

/// The desktop UI asks which app copy it is (MR-99); the phone isn't one.
#[tauri::command]
fn instance_id() -> Result<String, String> {
    Err("phone".into())
}

#[tauri::command(async)]
fn events_list(remote: tauri::State<'_, link::Remote>, after: Option<String>, limit: Option<i64>) -> Result<Vec<Box<serde_json::value::RawValue>>, String> {
    remote.cache.list(after.as_deref().unwrap_or(""), limit.unwrap_or(5000)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn events_session(remote: tauri::State<'_, link::Remote>, session_id: String) -> Result<Vec<Box<serde_json::value::RawValue>>, String> {
    remote.cache.session(&session_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn remote_state(remote: tauri::State<'_, link::Remote>) -> Value {
    remote.state()
}

#[tauri::command]
async fn remote_pair(app: tauri::AppHandle, text: String, name: String) -> Result<String, String> {
    link::pair(&app, &text, &name).await
}

/// One allowlisted command (`{kind, args}`, see `remote_link::proto::Command`); resolves with the Mac's ack.
#[tauri::command]
async fn remote_command(app: tauri::AppHandle, command: Value) -> Result<Value, String> {
    let command: remote_link::proto::Command = serde_json::from_value(command).map_err(|e| format!("not a Cockpit Remote command: {e}"))?;
    command.check()?;
    if let Some(why) = gate::reason(&command) {
        gate::check(&app, why).await?;
    }
    link::command(&app, command).await
}

#[tauri::command]
async fn remote_fetch(app: tauri::AppHandle, id: String) -> Result<(), String> {
    link::fetch(&app, id).await
}

/// Forget this Mac: drop the link, wipe the cache and the pairing, and make a new key.
#[tauri::command]
async fn remote_forget(app: tauri::AppHandle) -> Result<(), String> {
    link::forget(&app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_biometric::init());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let remote = link::Remote::open(&dir)?;
            app.manage(remote);
            link::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![instance_id, events_list, events_session, remote_state, remote_pair, remote_command, remote_fetch, remote_forget])
        .run(tauri::generate_context!())
        .expect("error while running Cockpit Remote");
}
