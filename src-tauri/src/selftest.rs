//! End-to-end self-test (MR_SELFTEST=1): starts a real session through the same commands the UI
//! uses, approves its permission request like a click on "Allow" would, then exits once the turn
//! finishes. scripts/selftest.sh runs it and checks the event log. Exits 1 on timeout.

use std::time::Duration;

use tauri::{AppHandle, Manager};

pub fn enabled() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "1")
}

pub fn run(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(2)).await;
        let dir = std::env::temp_dir().join(format!("mr-selftest-{}", ulid::Ulid::new()));
        let _ = std::fs::create_dir_all(&dir);
        let state = app.state::<crate::sidecar::Sidecar>();
        let res = crate::sidecar::session_start(
            app.clone(),
            state,
            dir.display().to_string(),
            "Use the AskUserQuestion tool to ask me to choose between the options alpha and beta. Then create an empty file named selftest-<my choice>.txt in the current directory, then reply with exactly: SELFTEST DONE".into(),
            None,
            None,
            Some("blank".into()),
        );
        if let Err(e) = res {
            eprintln!("[selftest] start failed: {e}");
            std::process::exit(1);
        }
        tokio_sleep(Duration::from_secs(150)).await;
        eprintln!("[selftest] timed out");
        std::process::exit(1);
    });
}

/// Called for every sidecar message while self-testing.
pub fn on_message(app: &AppHandle, payload: &serde_json::Value) {
    match payload["type"].as_str() {
        Some("permission_request") => {
            let mut input = payload["input"].clone();
            if payload["tool"] == "AskUserQuestion" {
                // Answer every question with its last option, like clicking it on the card.
                let mut answers = serde_json::Map::new();
                for q in input["questions"].as_array().cloned().unwrap_or_default() {
                    let pick = q["options"].as_array().and_then(|o| o.last()).map(|o| o["label"].clone()).unwrap_or_default();
                    answers.insert(q["question"].as_str().unwrap_or_default().into(), pick);
                }
                input["answers"] = serde_json::Value::Object(answers);
            }
            let decision = serde_json::json!({ "behavior": "allow", "updatedInput": input });
            let _ = crate::sidecar::permission_respond(
                app.clone(),
                app.state::<crate::sidecar::Sidecar>(),
                payload["session"].as_str().unwrap_or_default().into(),
                payload["request_id"].as_str().unwrap_or_default().into(),
                decision,
            );
        }
        Some("sdk") if payload["message"]["type"] == "result" => {
            let ok = payload["message"]["is_error"] == false;
            eprintln!("[selftest] result ok={ok}: {}", payload["message"]["result"]);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio_sleep(Duration::from_millis(500)).await;
                app.exit(if ok { 0 } else { 1 });
            });
        }
        _ => {}
    }
}

async fn tokio_sleep(d: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await.ok();
}
