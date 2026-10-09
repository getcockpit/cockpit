//! End-to-end self-test (MR_SELFTEST=1): starts a real session through the same commands the UI
//! uses, approves its permission request like a click on "Allow" would, then exits once the turn
//! finishes. scripts/selftest.sh runs it and checks the event log. Exits 1 on timeout.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use std::sync::atomic::{AtomicUsize, Ordering};

static RESULTS: AtomicUsize = AtomicUsize::new(0);

pub fn enabled() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "1" || v == "doc")
}

fn doc_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "doc")
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
            if doc_mode() {
                "Create a working document titled 'Selftest plan' with the mr doc_create tool. Add a goal block (block_id goal) whose takeaway is 'Prove the doc loop works', and an open question block (section question, block_id q1, takeaway 'Pick a colour') with data options red and blue. Don't decide it. Then reply with exactly: SELFTEST DONE".into()
            } else {
                "Use the AskUserQuestion tool to ask me to choose between the options alpha and beta. Then create an empty file named selftest-<my choice>.txt in the current directory, then reply with exactly: SELFTEST DONE".into()
            },
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
        Some("sdk") if payload["message"]["type"] == "result" && doc_mode() && RESULTS.fetch_add(1, Ordering::SeqCst) == 0 => {
            // Round 2: act like the user on the doc map — decide, note, Regenerate.
            let docs = app.state::<crate::docs::Docs>();
            let Some(doc) = docs.list().into_iter().find(|d| d.title == "Selftest plan") else {
                eprintln!("[selftest] Claude did not create the doc");
                std::process::exit(1);
            };
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            let anchor = format!("doc:{}", doc.id);
            crate::eventlog::record(app, Some(&session), "ui.doc_decision", &serde_json::json!({ "doc_id": doc.id, "block_id": "q1", "choice": "blue" }), Some(&anchor));
            crate::eventlog::record(app, Some(&session), "ui.doc_note", &serde_json::json!({ "doc_id": doc.id, "block_id": "goal", "text": "Mention that the colour is blue in the goal's key detail." }), Some(&anchor));
            let msg = crate::docs::doc_feedback(app.clone(), app.state::<crate::docs::Docs>(), doc.id.clone(), true).unwrap_or_default();
            let _ = crate::sidecar::session_send(app.clone(), app.state::<crate::sidecar::Sidecar>(), session, format!("{msg}\nWhen done, reply with exactly: SELFTEST DONE"));
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
