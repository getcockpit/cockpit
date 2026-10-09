//! Push-to-talk (MR-18): runs the on-device `mr-dictate` helper while the user holds ⌥ Space and
//! streams partial and final text to the UI as `voice` events. Final text is logged.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
pub struct Voice {
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
pub fn voice_start(app: AppHandle, voice: State<'_, Voice>) -> Result<(), String> {
    let mut slot = voice.child.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let (mut rx, child) = app.shell().sidecar("mr-dictate").map_err(|e| e.to_string())?.spawn().map_err(|e| e.to_string())?;
    *slot = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(i) = buf.find('\n') {
                        let line: String = buf.drain(..=i).collect();
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
                        if v["type"] == "final" {
                            crate::eventlog::record(&handle, None, "ui.voice_final", &serde_json::json!({ "text": v["text"] }), None);
                        }
                        let _ = handle.emit("voice", v);
                    }
                }
                CommandEvent::Terminated(_) => {
                    let _ = handle.emit("voice", serde_json::json!({ "type": "ended" }));
                    if let Some(v) = tauri::Manager::try_state::<Voice>(&handle) {
                        v.child.lock().unwrap().take();
                    }
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn voice_stop(voice: State<'_, Voice>) -> Result<(), String> {
    if let Some(child) = voice.child.lock().unwrap().as_mut() {
        child.write(b"stop\n").map_err(|e| e.to_string())?;
    }
    Ok(())
}
