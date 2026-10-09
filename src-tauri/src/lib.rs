mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar::Sidecar::default())
        .setup(|app| {
            sidecar::start(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar::sidecar_send])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
