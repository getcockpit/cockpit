// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Chrome starts the browser extension's native-messaging host as `Cockpit --browser-host …`.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "--browser-host") {
        std::process::exit(cockpit_lib::browser_host(&args));
    }
    cockpit_lib::run()
}
