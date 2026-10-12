//! End-to-end self-test (MR_SELFTEST=1): starts a real session through the same commands the UI
//! uses, approves its permission request like a click on "Allow" would, then exits once the turn
//! finishes. scripts/selftest.sh runs it and checks the event log. Exits 1 on timeout.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

static RESULTS: AtomicUsize = AtomicUsize::new(0);

pub fn enabled() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "1" || v == "doc" || v == "resume" || v == "flow" || v == "selfbuild" || v == "terminal" || v == "workspace" || v == "view" || v == "plan" || v == "title" || v == "update" || v == "bench" || v == "layer" || v == "skip" || v == "askfirst" || v == "brief" || v == "brieflayer")
}

/// Overhead benchmark: runs MR_BENCH_PROMPT in MR_BENCH_CWD and exits on the first result.
fn bench_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "bench")
}

fn workspace_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "workspace")
}

fn terminal_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "terminal")
}

fn selfbuild_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "selfbuild")
}

fn flow_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "flow")
}

fn resume_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "resume")
}

fn update_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "update")
}

fn title_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "title")
}

fn plan_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "plan")
}

fn view_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "view" || v == "layer")
}

/// The Cockpit layer (decision 34): a plain session, with the cards drawn afterwards on the layer's key.
fn layer_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "layer")
}

/// Skip on a question card (I75): Claude's question is declined with the card's Skip message.
fn skip_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "skip")
}

/// What the card's Skip sends; the same text as `SKIPPED` in ui/src/components/index.tsx.
const SKIPPED: &str = "I skipped this question: none of the options fit. Don't ask it again. Carry on with your best judgment and say in one line what you assumed, or stop if you can't go on without it.";

/// Ask me first on a question card (I75): the first question is declined with the card's message,
/// every later one answered, so Claude clarifies and then asks again.
fn ask_first_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "askfirst")
}

/// What the card's Ask me first sends; the same text as `ASK_FIRST` in ui/src/components/index.tsx.
const ASK_FIRST: &str = "None of these options fit. Before offering options again, ask me 1-3 short clarifying questions in one AskUserQuestion call (all of them together, each with your best-guess options; I can answer in my own words), then ask again with better options.";

static ASKS: AtomicUsize = AtomicUsize::new(0);

/// Did Claude finish the self-test's task: a selftest-<choice>.txt in the session's folder?
fn picked(app: &AppHandle, session: &str) -> bool {
    let events = app.state::<crate::eventlog::EventLog>().list(Some(session), None, 1000).unwrap_or_default();
    let cwd = events.iter().find(|e| e.kind == "ui.session_requested").and_then(|e| e.payload["cwd"].as_str().map(str::to_owned)).unwrap_or_default();
    std::fs::read_dir(cwd).map(|d| d.flatten().any(|f| f.file_name().to_string_lossy().starts_with("selftest-"))).unwrap_or(false)
}

/// Catch me up (MR-116): a turn that claims more than it did, a brief of it, then Continue with a correction.
fn brief_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "brief")
}

/// Catch me up mid-turn (MR-116): the Cockpit layer writes the brief, not the busy session.
fn brief_layer_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "brieflayer")
}
static BRIEFED: AtomicBool = AtomicBool::new(false);

fn doc_mode() -> bool {
    std::env::var("MR_SELFTEST").is_ok_and(|v| v == "doc")
}

pub fn run(app: AppHandle) {
    if selfbuild_mode() {
        return run_selfbuild(app);
    }
    if update_mode() {
        return run_update(app);
    }
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(2)).await;
        let dir = match std::env::var("MR_BENCH_CWD") {
            Ok(d) if bench_mode() => std::path::PathBuf::from(d),
            _ => std::env::temp_dir().join(format!("mr-selftest-{}", ulid::Ulid::new())),
        };
        let _ = std::fs::create_dir_all(&dir);
        if resume_mode() || brief_mode() {
            for args in [vec!["init", "-q", "-b", "main"], vec!["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]] {
                let _ = std::process::Command::new("git").arg("-C").arg(&dir).args(&args).status();
            }
        }
        if layer_mode() {
            crate::eventlog::record(&app, None, "ui.cockpit_layer_set", &serde_json::json!({ "on": true }), None);
        }
        let ws = if workspace_mode() { Some(crate::workspaces::workspace_create(app.clone(), "Selftest".into()).expect("workspace")) } else { None };
        let state = app.state::<crate::sidecar::Sidecar>();
        let res = crate::sidecar::session_start(
            app.clone(),
            state,
            dir.display().to_string(),
            if bench_mode() {
                std::env::var("MR_BENCH_PROMPT").unwrap_or_default()
            } else if terminal_mode() {
                "Remember the word MANGO. Reply with exactly: OK".into()
            } else if flow_mode() {
                "This is a UI test of the review tools, not a real review. Pretend you are reviewing a tiny change that adds a retry loop to fetch.ts. Call review_overview (tier 2, one '+' node 'retry loop', one net-new novelty item, total_snippets 1), then call review_snippet for snippet 1 of 1 with a short 3-line diff and exactly one finding with id f1, severity Important. Then stop and wait for my reply as the tool says.".into()
            } else if resume_mode() {
                "Remember this secret word for later: PINEAPPLE. Reply with exactly: OK".into()
            } else if title_mode() {
                // No tool or format named: the guidance alone should give a title and proposed replies (MR-63).
                "Create a file notes.txt in the current directory containing one line about rust lifetimes, then tell me in one sentence what you did.".into()
            } else if plan_mode() {
                // No tool named: the guidance alone should make Claude publish and update its plan (MR-62).
                "In the current directory, do these steps one at a time: create a.txt containing 'a', then create b.txt containing 'b', then create c.txt containing 'c', then list the directory to check all three exist. Then reply with exactly: SELFTEST DONE".into()
            } else if view_mode() {
                // No tool named: the visual guidance alone should make Claude compose a view (MR-61).
                std::env::var("MR_VIEW_PROMPT").ok().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "This is a UI test; nothing here is real and you don't need to look at any files. Give me a status report for a pretend settings refactor: 3 of 5 steps done, 211 tests passing, 1 test failing in the migration, and one open risk (old desktop builds can't read the new format). Then on a final line reply with exactly: SELFTEST DONE".into())
            } else if brief_layer_mode() {
                "This is a UI test. Run the shell command `sleep 40` with the Bash tool, then reply with exactly: SELFTEST DONE".into()
            } else if brief_mode() {
                "This is a UI test. Create a file retry.txt in the current directory containing the word retry. Don't run any tests. Then reply with exactly: Done, retries are in and all tests pass.".into()
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
            ws,
            None,
        );
        if let Err(e) = res {
            eprintln!("[selftest] start failed: {e}");
            std::process::exit(1);
        }
        tokio_sleep(Duration::from_secs(if bench_mode() { 900 } else { 150 })).await;
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
            let decision = if skip_mode() && payload["tool"] == "AskUserQuestion" {
                serde_json::json!({ "behavior": "deny", "message": SKIPPED })
            } else if ask_first_mode() && payload["tool"] == "AskUserQuestion" && ASKS.fetch_add(1, Ordering::SeqCst) == 0 {
                serde_json::json!({ "behavior": "deny", "message": ASK_FIRST })
            } else {
                serde_json::json!({ "behavior": "allow", "updatedInput": input })
            };
            let _ = crate::sidecar::permission_respond(
                app.clone(),
                app.state::<crate::sidecar::Sidecar>(),
                payload["session"].as_str().unwrap_or_default().into(),
                payload["request_id"].as_str().unwrap_or_default().into(),
                decision,
            );
        }
        Some("sdk") if payload["message"]["type"] == "result" && workspace_mode() => {
            // A fresh workspace isn't signed in: proof that Claude ran in its own config folder.
            let text = payload["message"]["result"].as_str().unwrap_or_default().to_owned();
            eprintln!("[selftest] workspace result: {text}");
            let app = app.clone();
            tauri::async_runtime::spawn(async move { tokio_sleep(Duration::from_millis(300)).await; app.exit(if text.to_lowercase().contains("not logged in") { 0 } else { 1 }); });
        }
        Some("sdk") if payload["message"]["type"] == "result" && layer_mode() => {
            // Wait for the layer's metered call after the turn, then stop; the script checks the log.
            let app = app.clone();
            std::thread::spawn(move || {
                for _ in 0..60 {
                    std::thread::sleep(Duration::from_millis(500));
                    if !app.state::<crate::eventlog::EventLog>().list_kind("cockpit.usage").unwrap_or_default().is_empty() {
                        std::thread::sleep(Duration::from_millis(500));
                        app.exit(0);
                        return;
                    }
                }
                eprintln!("[selftest] the layer never called");
                app.exit(1);
            });
        }
        Some("session_ended") if workspace_mode() => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { tokio_sleep(Duration::from_millis(500)).await; app.exit(1); });
        }
        Some("sdk") if payload["message"]["type"] == "result" && terminal_mode() && RESULTS.fetch_add(1, Ordering::SeqCst) == 0 => {
            // Take over in a real terminal, then type /exit like a user would.
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            let log = app.state::<crate::eventlog::EventLog>();
            let events = log.list(Some(&session), None, 1000).unwrap_or_default();
            let sdk = events.iter().find(|e| e.kind == "sidecar.session_started").and_then(|e| e.payload["sdk_session_id"].as_str().map(str::to_owned)).unwrap_or_default();
            let cwd = events.iter().find(|e| e.kind == "ui.session_requested").and_then(|e| e.payload["cwd"].as_str().map(str::to_owned)).unwrap_or_default();
            let app2 = app.clone();
            std::thread::spawn(move || {
                let r = crate::terminal::term_open(app2.clone(), session.clone(), sdk, cwd, 100, 30, None);
                if let Err(e) = r { eprintln!("[selftest] term_open failed: {e}"); std::process::exit(1); }
                std::thread::sleep(Duration::from_secs(8));
                let _ = crate::terminal::term_write(app2.state::<crate::terminal::Terminals>(), session.clone(), "/exit".into());
                std::thread::sleep(Duration::from_millis(600));
                let _ = crate::terminal::term_write(app2.state::<crate::terminal::Terminals>(), session, "\r".into());
            });
        }
        Some("sdk") if payload["message"]["type"] == "result" && flow_mode() && RESULTS.fetch_add(1, Ordering::SeqCst) == 0 => {
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            crate::eventlog::record(app, Some(&session), "ui.review_noted", &serde_json::json!({ "finding_id": "f1" }), Some("review:f1"));
            let _ = crate::sidecar::session_send(app.clone(), app.state::<crate::sidecar::Sidecar>(), session, "note f1. That was the last snippet: now call review_publish_ready with the noted finding and a verdict, then reply with exactly: SELFTEST DONE".into());
        }
        Some("sdk") if payload["message"]["type"] == "result" && resume_mode() && RESULTS.fetch_add(1, Ordering::SeqCst) == 0 => {
            // Round 1 done: stop the session; session_ended triggers the resume below.
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            // Its turn is over, so it no longer counts toward the cap (MR-105).
            let busy = crate::sidecar::busy(&app.state::<crate::sidecar::Sidecar>());
            crate::eventlog::record(app, Some(&session), "selftest.cap", &serde_json::json!({ "busy_after_turn": busy }), None);
            if busy != 0 { eprintln!("[selftest] an idle session still counts toward the cap ({busy} busy)"); std::process::exit(1); }
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
                sdk, None, Some("blank".into()), Some(false), Some(session), None, None,
            );
            if let Err(e) = res { eprintln!("[selftest] resume failed: {e}"); std::process::exit(1); }
        }
        Some("sdk") if brief_layer_mode() && payload["message"]["type"] == "assistant" && !BRIEFED.load(Ordering::SeqCst) => {
            // Mid-turn: Catch me up must go to the Cockpit layer and leave the session alone.
            BRIEFED.store(true, Ordering::SeqCst);
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            match crate::brief::brief_start(app.clone(), session) {
                Ok(r) if r["via"] == "cockpit" => eprintln!("[selftest] brief requested mid-turn: {r}"),
                r => { eprintln!("[selftest] mid-turn brief didn't go to the layer: {r:?}"); std::process::exit(1); }
            }
            let app = app.clone();
            std::thread::spawn(move || {
                for _ in 0..240 {
                    std::thread::sleep(Duration::from_millis(500));
                    let log = app.state::<crate::eventlog::EventLog>();
                    let done = ["brief.written", "brief.failed"].iter().any(|k| !log.list_kind(k).unwrap_or_default().is_empty());
                    if done {
                        std::thread::sleep(Duration::from_millis(500));
                        app.exit(0);
                        return;
                    }
                }
                eprintln!("[selftest] the layer never finished the brief");
                app.exit(1);
            });
        }
        Some("sdk") if payload["message"]["type"] == "result" && brief_mode() && RESULTS.load(Ordering::SeqCst) < 2 => {
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            if RESULTS.fetch_add(1, Ordering::SeqCst) == 0 {
                // The turn is over: Catch me up, written by the session's own Claude.
                match crate::brief::brief_start(app.clone(), session) {
                    Ok(r) if r["via"] == "session" => eprintln!("[selftest] brief requested: {r}"),
                    r => { eprintln!("[selftest] brief_start didn't go to the session: {r:?}"); std::process::exit(1); }
                }
                return;
            }
            // The brief is written: mark its first risk wrong with a note, the rest fine, then Continue.
            let docs = app.state::<crate::docs::Docs>();
            let Some(doc) = docs.list().into_iter().find(|d| d.kind == "brief" && d.session_id.as_deref() == Some(&session)) else {
                eprintln!("[selftest] no brief doc");
                std::process::exit(1);
            };
            let anchor = format!("doc:{}", doc.id);
            let mut risks: Vec<_> = doc.blocks.values().filter(|b| b.section == "risk").collect();
            risks.sort_by_key(|b| b.order);
            for (i, b) in risks.iter().enumerate() {
                crate::eventlog::record(app, Some(&session), "ui.doc_decision", &serde_json::json!({ "doc_id": doc.id, "block_id": b.id, "choice": if i == 0 { "Wrong" } else { "Fine" } }), Some(&anchor));
            }
            if let Some(b) = risks.first() {
                crate::eventlog::record(app, Some(&session), "ui.doc_note", &serde_json::json!({ "doc_id": doc.id, "block_id": b.id, "text": "Right, run nothing; just say so honestly." }), Some(&anchor));
            }
            let msg = crate::brief::brief_continue(app.clone(), app.state::<crate::docs::Docs>(), doc.id.clone()).ok().flatten();
            let Some(msg) = msg else { eprintln!("[selftest] Continue sent nothing despite a correction"); std::process::exit(1); };
            let _ = crate::sidecar::session_send(app.clone(), app.state::<crate::sidecar::Sidecar>(), session, format!("{msg}\nThis is a UI test: don't change files. Reply with exactly: SELFTEST DONE"));
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
        Some("sdk") if payload["message"]["type"] == "result" && ask_first_mode() && !picked(app, payload["session"].as_str().unwrap_or_default()) && RESULTS.fetch_add(1, Ordering::SeqCst) < 2 => {
            // Claude asked its clarifying questions in prose and ended the turn: reply like the user would.
            eprintln!("[selftest] clarifying turn: {}", payload["message"]["result"]);
            let session = payload["session"].as_str().unwrap_or_default().to_owned();
            let _ = crate::sidecar::session_send(app.clone(), app.state::<crate::sidecar::Sidecar>(), session, "Keep it simple: this is a throwaway test folder and either name is fine by me. Now ask me again.".into());
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

/// One-click Update for real (MR-66), under scripts/dev.sh: the first launch builds the other slot
/// and restarts into it; the relaunched app (MR_AUTO_RESUME=1) notes it came back and ends the run.
fn run_update(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(3)).await;
        if std::env::var("MR_AUTO_RESUME").is_ok_and(|v| v == "1") {
            crate::eventlog::record(&app, None, "selftest.update_back", &serde_json::json!({ "slot": std::env::var("MR_DEV_SLOT").ok() }), None);
            tokio_sleep(Duration::from_millis(500)).await;
            app.exit(0);
            return;
        }
        if let Err(e) = crate::update::update_start(app.clone()) {
            eprintln!("[selftest] update_start: {e}");
            std::process::exit(1);
        }
        for _ in 0..1200 {
            tokio_sleep(Duration::from_secs(1)).await;
            match crate::update::built() {
                Some(true) => {
                    let _ = crate::update::update_restart(app.clone());
                    return;
                }
                Some(false) => continue,
                None => { eprintln!("[selftest] update build failed"); std::process::exit(1); }
            }
        }
        std::process::exit(1);
    });
}

async fn tokio_sleep(d: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await.ok();
}

/// Self-build check: build this checkout, relaunch into the new build, and let the new build prove
/// it's healthy (it writes the marker on sidecar ready, then exits).
fn run_selfbuild(app: AppHandle) {
    std::thread::spawn(move || {
        if std::env::var("MR_FALLBACK").is_ok() {
            eprintln!("[selftest] running as the fallback: the new build failed");
            app.exit(1);
            return;
        }
        if std::env::var("MR_BUILD_ID").is_ok() {
            std::thread::sleep(Duration::from_secs(4));
            app.exit(0);
            return;
        }
        let repo = crate::changes::app_repo().expect("app repo");
        let id = crate::selfbuild::selfbuild_start(app.clone(), repo.display().to_string()).expect("build start");
        let marker = crate::selfbuild::data_dir(&app).join("builds").join(&id).join("build.json");
        let log = app.state::<crate::eventlog::EventLog>();
        for _ in 0..900 {
            let failed = log.list(None, None, i64::MAX).unwrap_or_default().into_iter().any(|e| e.kind == "selfbuild.finished" && e.payload["ok"] == false);
            if failed {
                eprintln!("[selftest] build failed");
                std::process::exit(1);
            }
            if marker.exists() {
                eprintln!("[selftest] build {id} stored; relaunching");
                let _ = crate::selfbuild::selfbuild_relaunch(app.clone(), id);
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        eprintln!("[selftest] build timed out");
        std::process::exit(1);
    });
}
