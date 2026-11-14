// The iOS app starts in lib.rs (mobile_entry_point); this runs it as a desktop window for development.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cockpit_remote_lib::run()
}
