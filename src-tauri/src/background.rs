//! Keeping Cockpit running for recurring sessions (MR-167), the same way on macOS, Windows and Linux:
//! closing the window hides it, a tray icon (menu bar / system tray / AppIndicator) stays with
//! Open, Recurring…, Pause all and Quit, and Cockpit starts at login with `--hidden` (LaunchAgent,
//! Run key, XDG autostart, via tauri-plugin-autostart). Settings → Background picks when:
//! `schedules` (the default: only while a schedule is active), `always` or `never`
//! (`ui.background_set {mode}`).

use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager};

pub const MODES: [&str; 3] = ["schedules", "always", "never"];
const TRAY: &str = "cockpit";

/// Your last valid `ui.background_set`, else `schedules`.
pub fn fold_mode<'a>(payloads: impl IntoIterator<Item = &'a serde_json::Value>) -> &'static str {
    payloads.into_iter().fold(MODES[0], |m, p| MODES.into_iter().find(|x| p["mode"].as_str() == Some(*x)).unwrap_or(m))
}

pub fn mode(app: &AppHandle) -> &'static str {
    let evs = app.state::<crate::eventlog::EventLog>().list_kind("ui.background_set").unwrap_or_default();
    fold_mode(evs.iter().map(|e| &e.payload))
}

/// Whether closing the window should leave Cockpit running.
pub fn keep_running(mode: &str, active_schedules: bool) -> bool {
    mode == "always" || (mode == "schedules" && active_schedules)
}

fn wanted(app: &AppHandle) -> bool {
    keep_running(mode(app), crate::schedules::any_active(app))
}

/// Start at login only from an installed app: dev loops, self-tests and self-builds would register
/// a build slot or a temporary binary.
fn may_autostart() -> bool {
    ["MR_SELFTEST", "MR_DEV_LOOP", "MR_DATA_DIR", "MR_BUILD_ID"].iter().all(|v| std::env::var(v).map_or(true, |x| x.is_empty())) && !cfg!(debug_assertions)
}

/// Brings the tray and start-at-login in line with the setting and the schedules.
pub fn refresh(app: &AppHandle) {
    let on = wanted(app);
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_visible(on);
        if let Ok(menu) = menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    if may_autostart() {
        use tauri_plugin_autostart::ManagerExt;
        let auto = app.autolaunch();
        let is = auto.is_enabled().unwrap_or(false);
        let r = if on && !is { auto.enable() } else if !on && is { auto.disable() } else { Ok(()) };
        if let Err(e) = r {
            eprintln!("[background] start at login: {e}");
        }
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let schedules = crate::schedules::list(app);
    let all_paused = !schedules.is_empty() && schedules.values().all(|s| s.paused());
    let pause = MenuItem::with_id(app, "pause", if all_paused { "Resume all schedules" } else { "Pause all schedules" }, !schedules.is_empty(), None::<&str>)?;
    Menu::with_items(app, &[
        &MenuItem::with_id(app, "open", "Open Cockpit", true, None::<&str>)?,
        &MenuItem::with_id(app, "recurring", "Recurring…", true, None::<&str>)?,
        &pause,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", "Quit Cockpit", true, None::<&str>)?,
    ])
}

fn tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let mut b = TrayIconBuilder::with_id(TRAY).tooltip("Cockpit").menu(&menu(app)?).show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.on_menu_event(|app, ev| match ev.id().as_ref() {
        "open" => show_main(app),
        "recurring" => {
            show_main(app);
            let _ = app.emit("mr-open-recurring", json!({}));
        }
        "pause" => {
            let all_paused = crate::schedules::list(app).values().all(|s| s.paused());
            crate::schedules::pause_all(app, !all_paused);
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)
}

/// At launch: the tray, start-at-login, and `--hidden` (a login launch starts in the background).
pub fn start(app: &AppHandle) {
    if let Err(e) = tray(app) {
        eprintln!("[background] tray: {e}");
    }
    refresh(app);
    if std::env::args().any(|a| a == "--hidden")
        && let Some(w) = app.get_webview_window("main")
    {
        let _ = w.hide();
    }
}

/// The window's ✕: hide instead of quitting while Cockpit should keep running. The first time, a
/// notification says where it went.
pub fn on_close(app: &AppHandle, window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.label() != "main" || !wanted(app) {
        return;
    }
    api.prevent_close();
    let _ = window.hide();
    let log = app.state::<crate::eventlog::EventLog>();
    if log.list_kind("background.hinted").unwrap_or_default().is_empty() {
        crate::eventlog::record(app, None, "background.hinted", &json!({}), None);
        let where_ = if cfg!(target_os = "macos") { "menu bar" } else { "system tray" };
        let _ = crate::notify::notify(app.clone(), crate::notify::Note {
            key: "background".into(),
            session: None,
            title: "Cockpit keeps running".into(),
            subtitle: "For your recurring sessions".into(),
            body: format!("It's in the {where_}. Quit from there, or change it in Settings → Sessions."),
            actions: vec![],
            reply: false,
        });
    }
}

#[tauri::command]
pub fn background_set(app: AppHandle, mode: String) -> Result<(), String> {
    if !MODES.contains(&mode.as_str()) {
        return Err(format!("unknown background mode: {mode}"));
    }
    crate::eventlog::record(&app, None, "ui.background_set", &json!({ "mode": mode }), None);
    refresh(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_while_schedules_exist_by_default() {
        let none: Vec<serde_json::Value> = vec![];
        assert_eq!(fold_mode(&none), "schedules");
        assert!(!keep_running("schedules", false));
        assert!(keep_running("schedules", true));
        assert!(keep_running("always", false));
        assert!(!keep_running("never", true));
        let set = [json!({ "mode": "always" }), json!({ "mode": "bogus" })];
        assert_eq!(fold_mode(&set), "always");
    }
}
