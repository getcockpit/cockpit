//! End-to-end self-test (MR_SELFTEST=1): starts a real session through the same commands the UI
//! uses, approves its permission request like a click on "Allow" would, then exits once the turn
//! finishes. scripts/selftest.sh runs it and checks the event log. Exits 1 on timeout.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use std::sync::atomic::{AtomicUsize, Ordering};

static RESULTS: AtomicUsize = AtomicUsize::new(0);

pub fn enabled() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "1" || v == "doc" || v == "resume" || v == "flow")
}

fn flow_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "flow")
}

fn resume_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "resume")
}

fn doc_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "doc")
}

pub fn run(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(2)).await;
        let dir = std::env::temp_dir().join(format!("mr-selftest-{}", ulid::Ulid::new()));
        let _ = std::fs::create_dir_all(&dir);
        if resume_mode() {
            for args in [vec!["init", "-q", "-b", "main"], vec!["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]] {
                let _ = std::process::Command::new("git").arg("-C").arg(&dir).args(&args).status();
            }
        }
        let state = app.state::<crate::sidecar::Sidecar>();
        let res = crate::sidecar::session_start(
            app.clone(),
            state,
            dir.display().to_string(),
            if flow_mode() {
                "This is a UI test of the review tools, not a real review. Pretend you are reviewing a tiny change that adds a retry loop to fetch.ts. Call review_overview (tier 2, one '+' node 'retry loop', one net-new novelty item, total_snippets 1), then call review_snippet for snippet 1 of 1 with a short 3-line diff and exactly one finding with id f1, severity Important. Then stop and wait for my reply as the tool says.".into()
            } else if resume_mode() {
                "Remember this secret word for later: PINEAPPLE. Reply with exactly: OK".into()
            } else if doc_mode() {
                "Create a working document titled 'Selftest plan' with the mr doc_create tool. Add a goal block (block_id goal) whose takeaway is 'Prove the doc loop works', and an open question block (section question, block_id q1, takeaway 'Pick a colour') with data options red and blue. Don't decide it. Then reply with exactly: SELFTEST DONE".into()
            } else {
                "Use the AskUserQuestion tool to ask me to choose between the options alpha and beta. Then create an empty file named selftest-<my choice>.txt in the current directory, then reply with exactly: SELFTEST DONE".into()
            },
            None,
            None,
            Some(if flow_mode() { "review".into() } else { "blank".into() }),
            Some(resume_mode()),
            None,
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
        Some("sdk") if payload["message"]["type"] == "result" && flow_mode() && RESULTS.fetch_add(1, Ordering::SeqCst) == 0 => {
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            crate::eventlog::record(app, Some(&session), "ui.review_noted", &serde_json::json!({ "finding_id": "f1" }), Some("review:f1"));
            let _ = crate::sidecar::session_send(app.clone(), app.state::<crate::sidecar::Sidecar>(), session, "note f1. That was the last snippet: now call review_publish_ready with the noted finding and a verdict, then reply with exactly: SELFTEST DONE".into());
        }
        Some("sdk") if payload["message"]["type"] == "result" && resume_mode() && RESULTS.fetch_add(1, Ordering::SeqCst) == 0 => {
            // Round 1 done: stop the session; session_ended triggers the resume below.
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            let _ = crate::sidecar::session_stop(app.state::<crate::sidecar::Sidecar>(), session);
        }
        Some("session_ended") if resume_mode() && RESULTS.load(Ordering::SeqCst) == 1 => {
            RESULTS.fetch_add(1, Ordering::SeqCst);
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            let log = app.state::<crate::eventlog::EventLog>();
            let events = log.list(Some(&session), None, 1000).unwrap_or_default();
            let sdk = events.iter().find(|e| e.kind == "sidecar.session_started").and_then(|e| e.payload["sdk_session_id"].as_str().map(str::to_owned));
            let cwd = events.iter().find(|e| e.kind == "ui.session_requested").and_then(|e| e.payload["cwd"].as_str().map(str::to_owned)).unwrap_or_default();
            let res = crate::sidecar::session_start(
                app.clone(), app.state::<crate::sidecar::Sidecar>(), cwd,
                "What secret word did I ask you to remember? Reply with just the word, then on a new line: SELFTEST DONE".into(),
                sdk, None, Some("blank".into()), Some(false), Some(session),
            );
            if let Err(e) = res { eprintln!("[selftest] resume failed: {e}"); std::process::exit(1); }
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
