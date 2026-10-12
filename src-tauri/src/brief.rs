//! Catch me up (MR-116): an executive brief for a session you lost track of. Cockpit creates a
//! working doc of `kind: brief` linked to the session, then has it written: by the session's own
//! Claude when it's between turns (it has the full context and can run git and tests), or by the
//! Cockpit layer from a digest of the event log when the session is mid-turn. You mark what looks
//! wrong and answer what's open in the Doc Map; Continue sends only your corrections back into the
//! same session, and closes silently when there are none.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::eventlog::Event;

/// How much of the log the layer reads, in characters: the user's asks always, then the newest rest.
const DIGEST_CHARS: usize = 40_000;

/// What every brief contains, for whoever writes it. `can_check`: whether the writer can run git
/// and tests (the session's own Claude) or only reads the log (the layer).
pub fn instructions(doc_id: &str, can_check: bool) -> String {
    let verify = if can_check {
        "Before writing, check what you can: `git log --oneline` and `git status` in the working folder, and the last test run (run the tests again if that's quick)."
    } else {
        "You only have the session's event log below; you can't run anything. Where a claim needs a check you can't make, say \"not verified\"."
    };
    format!(
        "Write a catch-up brief into working doc {doc_id} with doc_set_block (the doc already exists; don't create another). The user lost track of this session and wants to read where it stands in under a minute. {verify}\n\
Write it as a pyramid: context, then the problems (worst first), the options for each, the one you recommend, and the details last, so each level can be skipped. Blocks, each with a short takeaway, a key detail and a catalog view:\n\
- goal (block_id where): the context — the original ask (with later corrections) and the current step, in one line. View: stats or progress.\n\
- risk (one block each, block_id risk_<n>, worst first): something that looks wrong. Run all five checks, broken or fake-done first, and add a block for each that fires: \"done\" with no diff, no test run, or a failing build or last test run; drift from the original ask, later corrections, the plan steps or linked docs; contradicts a decision (docs/DECISIONS.md, CLAUDE.md rules); the same error in 3+ turns or plan steps marked done with no change; a question the user never answered that was assumed. Name the baseline each one breaks. View: risks.\n\
- question (one block each, block_id q_<n>): the ways forward for a risk, or anything still waiting on the user. Give data.options (2-3), each a concrete action you will carry out if the user picks it (picking one is an order, applied on Continue), and mark the one you recommend, with a one-line why. View: compare with recommended, or decision.\n\
- design (block_id next): the next step you were about to take. View: steps.\n\
- log (block_id done): the details — what's done: commits, files changed, decisions made. View: takeaway.\n\
Every block cites its evidence in the body: a commit, file:line, an event id like [01J…] or a short quote. Say plainly what you couldn't verify. If nothing looks wrong, add one risk block saying so. Don't change code and don't carry on with the task: stop once the brief is written."
    )
}

/// The session's log as the layer reads it: every user message, Claude's words and tool calls,
/// errors, plan state, linked docs and turn ends, each tagged with its event id for citations.
/// Over the cap, the oldest lines that aren't the user's go first.
pub fn digest(evs: &[Event]) -> String {
    let mut lines: Vec<(bool, String)> = vec![];
    let mut first = true;
    for e in evs {
        let p = &e.payload;
        let id = &e.id;
        match e.kind.as_str() {
            "ui.session_requested" => {
                lines.push((true, format!("[{id}] USER (original ask): {}", clip(p["prompt"].as_str().unwrap_or(""), if first { 3000 } else { 800 }))));
                first = false;
            }
            "ui.message_sent" => lines.push((true, format!("[{id}] USER: {}", clip(p["text"].as_str().unwrap_or(""), 800)))),
            "plan.updated" => {
                let steps: Vec<String> = p["steps"].as_array().into_iter().flatten().map(|s| format!("{} ({})", s["step"].as_str().unwrap_or(""), s["status"].as_str().unwrap_or(""))).collect();
                lines.push((false, format!("[{id}] PLAN: {}", steps.join("; "))));
            }
            "doc.created" => lines.push((false, format!("[{id}] DOC {}: {}", p["doc_id"].as_str().unwrap_or(""), p["title"].as_str().unwrap_or("")))),
            "sidecar.sdk" => {
                let m = &p["message"];
                match m["type"].as_str() {
                    Some("assistant") => {
                        for b in m["message"]["content"].as_array().into_iter().flatten() {
                            match b["type"].as_str() {
                                Some("text") => lines.push((false, format!("[{id}] CLAUDE: {}", clip(b["text"].as_str().unwrap_or(""), 600)))),
                                Some("tool_use") => lines.push((false, format!("[{id}] TOOL {}: {}", b["name"].as_str().unwrap_or(""), clip(&tool_gist(&b["input"]), 200)))),
                                _ => {}
                            }
                        }
                    }
                    Some("user") => {
                        for b in m["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "tool_result" && b["is_error"] == true) {
                            let text = b["content"].as_str().map(str::to_owned).unwrap_or_else(|| b["content"].to_string());
                            lines.push((false, format!("[{id}] ERROR: {}", clip(&text, 300))));
                        }
                    }
                    Some("result") => lines.push((false, format!("[{id}] TURN ENDED ({})", m["subtype"].as_str().unwrap_or("")))),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let mut total: usize = lines.iter().map(|(_, l)| l.len() + 1).sum();
    let mut trimmed = false;
    let mut i = 0;
    while total > DIGEST_CHARS && i < lines.len() {
        if !lines[i].0 {
            total -= lines[i].1.len() + 1;
            lines.remove(i);
            trimmed = true;
        } else {
            i += 1;
        }
    }
    let body = lines.into_iter().map(|(_, l)| l).collect::<Vec<_>>().join("\n");
    if trimmed { format!("(older turns trimmed; the user's messages are all kept)\n{body}") } else { body }
}

/// The part of a tool call that says what it did: a command, a path, or the raw input.
fn tool_gist(input: &Value) -> String {
    for k in ["command", "file_path", "path", "pattern", "doc_id"] {
        if let Some(s) = input[k].as_str() {
            return s.to_owned();
        }
    }
    input.to_string()
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s.to_owned() }
}

/// The session's title: the latest one set, else the start of its first ask.
fn title_of(evs: &[Event]) -> String {
    evs.iter().rev().find(|e| e.kind == "session.titled").and_then(|e| e.payload["title"].as_str().map(str::to_owned))
        .or_else(|| evs.iter().find(|e| e.kind == "ui.session_requested").map(|e| clip(e.payload["prompt"].as_str().unwrap_or("this session"), 50)))
        .unwrap_or_else(|| "this session".into())
}

/// The session's working folder (its worktree if it has one).
fn folder_of(evs: &[Event]) -> Option<String> {
    let p = &evs.iter().find(|e| e.kind == "ui.session_requested")?.payload;
    p["worktree"].as_str().or(p["cwd"].as_str()).map(str::to_owned)
}

fn git(folder: &str, args: &[&str]) -> String {
    std::process::Command::new("git").arg("-C").arg(folder).args(args).output().ok()
        .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

/// The one tool the layer answers with: the brief's blocks.
fn brief_tool() -> Value {
    json!({
        "name": "brief",
        "description": "The catch-up brief's blocks.",
        "input_schema": {
            "type": "object",
            "properties": {
                "blocks": { "type": "array", "items": { "type": "object", "properties": {
                    "block_id": { "type": "string" }, "section": { "type": "string", "enum": ["goal", "log", "design", "question", "risk"] },
                    "takeaway": { "type": "string" }, "key": { "type": "string" }, "body": { "type": "string" },
                    "data": { "type": "object" }, "view": { "type": "array", "items": { "type": "object" } }
                }, "required": ["section", "takeaway"] } }
            },
            "required": ["blocks"]
        }
    })
}

/// The `doc.block_set` events for the layer's blocks, each checked like Claude's doc_set_block.
/// A block whose view fails the catalog check keeps its text and loses the view.
pub fn block_events(docs: &crate::docs::Docs, doc_id: &str, input: &Value) -> Vec<(String, Value)> {
    let mut out = vec![];
    for b in input["blocks"].as_array().into_iter().flatten() {
        let mut args = b.clone();
        args["doc_id"] = doc_id.into();
        let (mut evs, _, err) = crate::docs::handle_tool(docs, None, "doc_set_block", &args);
        if err && !args["view"].is_null() {
            args.as_object_mut().map(|o| o.remove("view"));
            evs = crate::docs::handle_tool(docs, None, "doc_set_block", &args).0;
        }
        out.extend(evs);
    }
    out
}

/// Writes the brief with the Cockpit layer, off the calling thread. A failure lands in the doc as
/// a log block, so the map never just sits empty.
fn write_with_layer(app: AppHandle, session: String, doc_id: String, evs: Vec<Event>) {
    std::thread::spawn(move || {
        let folder = folder_of(&evs);
        let gitinfo = folder.as_deref().map(|f| format!("git log --oneline -15:\n{}\ngit status --short:\n{}", git(f, &["log", "--oneline", "-15"]), clip(&git(f, &["status", "--short"]), 3000))).unwrap_or_default();
        let docs = app.state::<crate::docs::Docs>();
        let linked: Vec<String> = docs.list().into_iter().filter(|d| d.session_id.as_deref() == Some(&session) && d.id != doc_id).map(|d| crate::docs::to_markdown(&d)).collect();
        let prompt = format!("{}\n\nLinked working docs:\n{}\n\n{gitinfo}\n\nThe session's log:\n{}", instructions(&doc_id, false), if linked.is_empty() { "(none)".into() } else { clip(&linked.join("\n\n"), 12_000) }, digest(&evs));
        let system = format!("You are Cockpit's catch-up writer. You never talk to the coding agent; answer only by calling `brief` once. Use only facts in the log, git output and docs you're given. View blocks:\n{}",
            crate::views::tool_spec()["description"].as_str().unwrap_or("").split_once("blocks: array of objects, each with a `type` and its fields:\n").map(|x| x.1).unwrap_or(""));
        let body = json!({ "model": crate::cockpit_layer::MODEL, "max_tokens": 6000, "system": system, "messages": [{ "role": "user", "content": prompt }], "tools": [brief_tool()], "tool_choice": { "type": "tool", "name": "brief" } });
        let anchor = format!("doc:{doc_id}");
        match crate::cockpit_layer::call(&app, "brief", Some(&session), body) {
            Ok(r) => {
                let input = r["content"].as_array().into_iter().flatten().find(|b| b["type"] == "tool_use").map(|b| b["input"].clone()).unwrap_or(Value::Null);
                let events = block_events(&docs, &doc_id, &input);
                let n = events.len();
                for (kind, p) in events {
                    crate::eventlog::record(&app, Some(&session), &kind, &p, Some(&anchor));
                }
                crate::eventlog::record(&app, Some(&session), "brief.written", &json!({ "doc_id": doc_id, "via": "cockpit", "blocks": n }), Some(&anchor));
            }
            Err(e) => {
                let p = json!({ "doc_id": doc_id, "block_id": "failed", "section": "log", "takeaway": "Couldn't write the brief while the session is working", "key": clip(&e, 120), "body": format!("The Cockpit layer failed: {e}\n\nWait for the turn to end and press Catch me up again: the session's own Claude writes it then."), "view": [] });
                crate::eventlog::record(&app, Some(&session), "doc.block_set", &p, Some(&anchor));
                crate::eventlog::record(&app, Some(&session), "brief.failed", &json!({ "doc_id": doc_id, "error": e }), Some(&anchor));
            }
        }
    });
}

/// Catch me up: creates the brief doc and has it written. Returns {doc_id, via: session|cockpit}.
#[tauri::command(async)]
pub fn brief_start(app: AppHandle, session: String) -> Result<Value, String> {
    let evs = app.state::<crate::eventlog::EventLog>().list(Some(&session), None, 100_000).map_err(|e| e.to_string())?;
    if evs.is_empty() {
        return Err("no such session".into());
    }
    let doc_id = format!("doc_{}", &ulid::Ulid::new().to_string()[..10].to_lowercase());
    let own = crate::sidecar::can_take_turn(&app, &session);
    let via = if own { "session" } else { "cockpit" };
    let anchor = format!("doc:{doc_id}");
    crate::eventlog::record(&app, Some(&session), "ui.brief_requested", &json!({ "doc_id": doc_id, "via": via }), Some(&anchor));
    crate::eventlog::record(&app, Some(&session), "doc.created", &json!({ "doc_id": doc_id, "title": format!("Catch-up: {}", title_of(&evs)), "kind": "brief" }), Some(&anchor));
    if own {
        let state = app.state::<crate::sidecar::Sidecar>();
        if crate::sidecar::session_send(app.clone(), state, session.clone(), instructions(&doc_id, true)).is_err() {
            write_with_layer(app, session, doc_id.clone(), evs);
            return Ok(json!({ "doc_id": doc_id, "via": "cockpit" }));
        }
    } else {
        write_with_layer(app, session, doc_id.clone(), evs);
    }
    Ok(json!({ "doc_id": doc_id, "via": via }))
}

/// Continue: your decisions and corrections on the brief as one message for the session, or None
/// when you only marked things fine (decided: close silently, no extra turn). Decisions are orders
/// the session carries out before it resumes (I90). Clears the doc's pending input either way; the
/// UI delivers the message.
#[tauri::command]
pub fn brief_continue(app: AppHandle, docs: tauri::State<'_, crate::docs::Docs>, doc_id: String) -> Result<Option<String>, String> {
    let doc = docs.get(&doc_id).ok_or("no such doc")?;
    let msg = continue_message(&doc);
    let anchor = format!("doc:{}", doc.id);
    let session = doc.session_id.as_deref();
    if msg.is_some() {
        crate::eventlog::record(&app, session, "ui.doc_feedback_sent", &json!({ "doc_id": doc.id, "regenerate": false }), Some(&anchor));
    }
    crate::eventlog::record(&app, session, "ui.brief_continued", &json!({ "doc_id": doc.id, "silent": msg.is_none() }), Some(&anchor));
    Ok(msg)
}

/// A pending change that is a decision on a question (docs.rs writes them as `Decided "…": …`).
pub fn is_decision(change: &str) -> bool {
    change.starts_with("Decided ")
}

pub fn continue_message(doc: &crate::docs::Doc) -> Option<String> {
    if doc.pending_changes.is_empty() && doc.pending_notes.is_empty() {
        return None;
    }
    let (decisions, corrections): (Vec<&String>, Vec<&String>) = doc.pending_changes.iter().partition(|c| is_decision(c));
    let mut msg = format!("The user caught up on this session with the brief \"{}\" ({}).\n", doc.title, doc.id);
    if !decisions.is_empty() {
        msg.push_str("\nTheir decisions. Carry out each one now, without asking again (doc_read the brief for what each option means):\n");
        for c in &decisions {
            msg.push_str(&format!("- {c}\n"));
        }
    }
    if !corrections.is_empty() || !doc.pending_notes.is_empty() {
        msg.push_str("\nTheir corrections:\n");
        for c in &corrections {
            msg.push_str(&format!("- {c}\n"));
        }
        for (block, text) in &doc.pending_notes {
            let what = doc.blocks.get(block).map(|b| b.takeaway.as_str()).unwrap_or(block);
            msg.push_str(&format!("- on \"{what}\": {text}\n"));
        }
    }
    msg.push_str(if decisions.is_empty() { "\nTake these into account and resume from where you stopped." } else { "\nApply the decisions first, then resume from where you stopped. Say briefly what you did for each." });
    Some(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(n: u32, kind: &str, payload: Value) -> Event {
        Event { id: format!("E{n:04}"), session_id: Some("s1".into()), kind: kind.into(), payload, anchor: None, created_at: n as i64, origin: None }
    }
    fn sdk(n: u32, m: Value) -> Event {
        ev(n, "sidecar.sdk", json!({ "message": m }))
    }

    #[test]
    fn the_digest_cites_event_ids_and_keeps_asks_errors_and_plan() {
        let evs = vec![
            ev(1, "ui.session_requested", json!({ "prompt": "Add retries to the webhook" })),
            sdk(2, json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "On it." }, { "type": "tool_use", "name": "Bash", "input": { "command": "cargo test" } }] } })),
            sdk(3, json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "is_error": true, "content": "test retry_once failed" }, { "type": "tool_result", "content": "fine" }] } })),
            ev(4, "plan.updated", json!({ "steps": [{ "step": "Write retry", "status": "done" }] })),
            sdk(5, json!({ "type": "result", "subtype": "success" })),
            ev(6, "ui.message_sent", json!({ "text": "Cap it at 5" })),
        ];
        let d = digest(&evs);
        for want in ["[E0001] USER (original ask): Add retries", "[E0002] TOOL Bash: cargo test", "[E0003] ERROR: test retry_once failed", "[E0004] PLAN: Write retry (done)", "[E0005] TURN ENDED (success)", "[E0006] USER: Cap it at 5"] {
            assert!(d.contains(want), "missing {want} in\n{d}");
        }
        assert!(!d.contains("fine"));
    }

    #[test]
    fn a_long_log_drops_old_work_but_keeps_every_user_message() {
        let mut evs = vec![ev(0, "ui.session_requested", json!({ "prompt": "The original ask" }))];
        for n in 1..400 {
            evs.push(sdk(n, json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "x".repeat(500) }] } })));
        }
        evs.push(ev(400, "ui.message_sent", json!({ "text": "late correction" })));
        let d = digest(&evs);
        assert!(d.len() <= DIGEST_CHARS + 100, "{}", d.len());
        assert!(d.starts_with("(older turns trimmed") && d.contains("The original ask") && d.contains("late correction"));
        assert!(d.contains("[E0399] CLAUDE") && !d.contains("[E0001] CLAUDE"));
    }

    #[test]
    fn layer_blocks_are_checked_and_a_bad_view_is_dropped_not_the_block() {
        let docs = crate::docs::Docs::default();
        docs.apply(&ev(1, "doc.created", json!({ "doc_id": "d", "title": "Catch-up", "kind": "brief" })));
        let input = json!({ "blocks": [
            { "block_id": "where", "section": "goal", "takeaway": "Retries half done", "view": [{ "type": "made_up" }] },
            { "block_id": "risk_1", "section": "risk", "takeaway": "No test run", "view": [{ "type": "risks", "items": [{ "risk": "untested", "mitigation": "run cargo test" }] }] },
            { "section": "nonsense", "takeaway": "dropped" }
        ] });
        let evs = block_events(&docs, "d", &input);
        assert_eq!(evs.len(), 2);
        assert!(evs[0].1.get("view").is_none());
        assert_eq!(evs[1].1["view"][0]["type"], "risks");
    }

    #[test]
    fn continue_is_silent_when_risks_are_only_marked_fine_and_carries_corrections_otherwise() {
        let docs = crate::docs::Docs::default();
        docs.apply(&ev(1, "doc.created", json!({ "doc_id": "d", "title": "Catch-up: retries", "kind": "brief" })));
        docs.apply(&ev(2, "doc.block_set", json!({ "doc_id": "d", "block_id": "risk_1", "section": "risk", "takeaway": "No test run" })));
        docs.apply(&ev(3, "doc.block_set", json!({ "doc_id": "d", "block_id": "risk_2", "section": "risk", "takeaway": "Drifted to UI" })));
        let d = docs.get("d").unwrap();
        assert_eq!(d.kind, "brief");
        docs.apply(&ev(4, "ui.doc_decision", json!({ "doc_id": "d", "block_id": "risk_1", "choice": "Fine" })));
        assert_eq!(continue_message(&docs.get("d").unwrap()), None);
        docs.apply(&ev(5, "ui.doc_decision", json!({ "doc_id": "d", "block_id": "risk_2", "choice": "Wrong" })));
        docs.apply(&ev(6, "ui.doc_note", json!({ "doc_id": "d", "block_id": "risk_2", "text": "stay on the webhook" })));
        let msg = continue_message(&docs.get("d").unwrap()).unwrap();
        assert!(msg.contains("Confirmed this looks wrong: \"Drifted to UI\""), "{msg}");
        assert!(msg.contains("on \"Drifted to UI\": stay on the webhook") && msg.contains("resume from where you stopped"), "{msg}");
        assert!(!msg.contains("No test run"), "{msg}");
        assert!(!msg.contains("Carry out"), "{msg}");
    }

    #[test]
    fn continue_turns_question_decisions_into_orders_applied_before_resuming() {
        let docs = crate::docs::Docs::default();
        docs.apply(&ev(1, "doc.created", json!({ "doc_id": "d", "title": "Catch-up: retries", "kind": "brief" })));
        docs.apply(&ev(2, "doc.block_set", json!({ "doc_id": "d", "block_id": "risk_1", "section": "risk", "takeaway": "Not recorded" })));
        docs.apply(&ev(3, "doc.block_set", json!({ "doc_id": "d", "block_id": "q_1", "section": "question", "takeaway": "Record it?", "data": { "options": [{ "label": "Record it now" }, { "label": "Skip" }] } })));
        docs.apply(&ev(4, "ui.doc_decision", json!({ "doc_id": "d", "block_id": "risk_1", "choice": "Wrong" })));
        docs.apply(&ev(5, "ui.doc_decision", json!({ "doc_id": "d", "block_id": "q_1", "choice": "Record it now" })));
        let msg = continue_message(&docs.get("d").unwrap()).unwrap();
        let (orders, fixes) = (msg.find("Carry out each one now").unwrap(), msg.find("Their corrections").unwrap());
        assert!(orders < msg.find("Decided \"Record it?\": Record it now").unwrap() && msg.find("Decided").unwrap() < fixes, "{msg}");
        assert!(msg[fixes..].contains("Confirmed this looks wrong: \"Not recorded\"") && msg.ends_with("Say briefly what you did for each."), "{msg}");
    }
}
