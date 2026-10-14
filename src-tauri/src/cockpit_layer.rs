//! The Cockpit layer (decision 34): everything Cockpit adds on top of Claude Code runs here, on its
//! own key, outside the user's Claude session. With the layer on, sessions run as plain Claude Code
//! (no visual guidance, no view tools), and after each turn a small model reads what the session
//! said and turns it into the same `view.rendered` / `plan.updated` / `session.titled` events the
//! session used to make itself. Nothing goes back into the session.
//!
//! Every model call Cockpit makes goes through `call`, which logs one `cockpit.usage` event (what
//! for, model, tokens, list $) and never the key or the text, so Cockpit's overhead is one meter
//! that can be billed on its own. The key is the user's for now (Keychain, never files or the log);
//! `MR_COCKPIT_BASE_URL` is where a hosted, metered endpoint with a short-lived token would plug in.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const KEYCHAIN_SERVICE: &str = "cockpit.anthropic";
const KEYCHAIN_ACCOUNT: &str = "cockpit";
pub const MODEL: &str = "claude-haiku-5-5";
/// List prices, $ per million tokens: (input, output). Cache reads 0.1×, writes 1.25× input.
const PRICES: &[(&str, f64, f64)] = &[("haiku", 1.0, 5.0), ("sonnet", 3.0, 15.0), ("opus", 5.0, 25.0)];
/// The tail of a turn the layer reads, in characters: enough for a report, bounded in cost.
const TURN_CHARS: usize = 16_000;

/// Whether the layer is on, folded from `ui.cockpit_layer_set {on}` events (default off).
pub fn fold_on<'a>(payloads: impl IntoIterator<Item = &'a Value>) -> bool {
    payloads.into_iter().fold(false, |on, p| p["on"].as_bool().unwrap_or(on))
}

pub fn on(app: &AppHandle) -> bool {
    let evs = app.state::<crate::eventlog::EventLog>().list_kind("ui.cockpit_layer_set").unwrap_or_default();
    fold_on(evs.iter().map(|e| &e.payload))
}

fn key() -> Option<String> {
    if let Ok(k) = std::env::var("MR_COCKPIT_API_KEY") {
        return Some(k).filter(|k| !k.is_empty());
    }
    crate::migrate::keychain_get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

/// Anthropic keys are `sk-ant-` plus letters, digits, `-` and `_`; anything else is a paste mistake.
pub fn valid_key(key: &str) -> bool {
    key.starts_with("sk-ant-") && key.len() > 20 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Saves the key through `security -i` on stdin, so it never shows up in a process list.
// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn cockpit_save_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if !valid_key(key) {
        return Err("that doesn't look like an Anthropic API key (sk-ant-…)".into());
    }
    let mut child = Command::new("security").arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let line = format!("add-generic-password -U -s {KEYCHAIN_SERVICE} -a {KEYCHAIN_ACCOUNT} -w {key}\n");
    child.stdin.take().ok_or("no stdin")?.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    if std::env::var("MR_COCKPIT_API_KEY").is_err() && self::key().as_deref() != Some(key) {
        return Err("couldn't save to the Keychain".into());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn cockpit_status() -> Value {
    json!({ "configured": key().is_some() })
}

/// List $ for one call's usage.
pub fn cost(model: &str, u: &Value) -> f64 {
    let (i, o) = PRICES.iter().find(|(name, _, _)| model.contains(name)).map(|(_, i, o)| (*i, *o)).unwrap_or((1.0, 5.0));
    let n = |k: &str| u[k].as_f64().unwrap_or(0.0);
    (n("input_tokens") * i + n("cache_read_input_tokens") * i * 0.1 + n("cache_creation_input_tokens") * i * 1.25 + n("output_tokens") * o) / 1e6
}

/// One Messages API call on the Cockpit key, metered: logs `cockpit.usage` whether it worked or not.
/// `purpose` names what Cockpit spent it on (render, diagram, …). Returns the response body.
pub fn call(app: &AppHandle, purpose: &str, session: Option<&str>, body: Value) -> Result<Value, String> {
    let t0 = Instant::now();
    let model = body["model"].as_str().unwrap_or(MODEL).to_owned();
    let result = key().ok_or_else(|| "no Cockpit key; add one in Settings → Cockpit layer".to_string()).and_then(|k| {
        let base = std::env::var("MR_COCKPIT_BASE_URL").unwrap_or_else(|_| "https://api.anthropic.com".into());
        ureq::post(&format!("{}/v1/messages", base.trim_end_matches('/')))
            .header("x-api-key", &k)
            .header("anthropic-version", "2023-06-01")
            .send_json(&body)
            .map_err(|e| e.to_string())?
            .body_mut()
            .read_json::<Value>()
            .map_err(|e| e.to_string())
    });
    let ms = t0.elapsed().as_millis() as u64;
    let usage = match &result {
        Ok(r) => {
            let u = &r["usage"];
            json!({ "purpose": purpose, "model": model, "ok": true, "ms": ms, "cost_usd": cost(&model, u),
                "input_tokens": u["input_tokens"], "output_tokens": u["output_tokens"],
                "cache_read_input_tokens": u["cache_read_input_tokens"], "cache_creation_input_tokens": u["cache_creation_input_tokens"] })
        }
        Err(e) => json!({ "purpose": purpose, "model": model, "ok": false, "ms": ms, "cost_usd": 0.0, "error": e }),
    };
    crate::eventlog::record(app, session, "cockpit.usage", &usage, None);
    result
}

/// A plain text completion on the Cockpit key (for helpers like diagrams).
pub fn complete(app: &AppHandle, purpose: &str, session: Option<&str>, system: &str, prompt: &str) -> Result<String, String> {
    let body = json!({ "model": MODEL, "max_tokens": 2000, "system": system, "messages": [{ "role": "user", "content": prompt }] });
    let r = call(app, purpose, session, body)?;
    Ok(r["content"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(""))
}

/// The last turn as the layer reads it: what the user asked, what Claude said, which tools it used.
/// `evs` are the session's events in order; the turn is everything after the previous result.
pub fn turn_text(evs: &[(String, Value)]) -> String {
    let sdk = |p: &Value| p["message"].clone();
    let ends: Vec<usize> = evs.iter().enumerate().filter(|(_, (k, p))| k == "sidecar.sdk" && sdk(p)["type"] == "result").map(|(i, _)| i).collect();
    let end = ends.last().copied().unwrap_or(evs.len());
    let start = if ends.len() > 1 { ends[ends.len() - 2] + 1 } else { 0 };
    let mut out = vec![];
    for (k, p) in &evs[start..end] {
        match k.as_str() {
            "ui.session_requested" => out.push(format!("USER: {}", p["prompt"].as_str().unwrap_or(""))),
            "ui.message_sent" => out.push(format!("USER: {}", p["text"].as_str().unwrap_or(""))),
            "sidecar.sdk" if sdk(p)["type"] == "assistant" => {
                for b in sdk(p)["message"]["content"].as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("text") => out.push(format!("CLAUDE: {}", b["text"].as_str().unwrap_or(""))),
                        Some("tool_use") => out.push(format!("[tool {} {}]", b["name"].as_str().unwrap_or(""), clip(&b["input"].to_string(), 160))),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    let all = out.join("\n");
    let n = all.chars().count();
    if n > TURN_CHARS { format!("…{}", all.chars().skip(n - TURN_CHARS).collect::<String>()) } else { all }
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s.to_owned() }
}

fn system() -> String {
    format!(
        "You are Cockpit's render layer. A coding agent (Claude Code) just finished a turn; you turn it into the app's visual cards. You never talk to the agent or the user: call `show` once.\n\
- title: 2-6 words naming what the thread is about, sentence case. Only when there's no title yet or the focus clearly shifted.\n\
- plan: only when the work has 3 or more steps; the full list, each {{step, status: 'done'|'doing'|'todo'}}, updating the current plan's statuses from what the turn did.\n\
- view: only when the turn ends with a status report, summary, comparison, verification result, findings or options; omit it for short or conversational replies. End it with a `next` block holding 1-3 replies the user is likely to send.\n\
Use only facts stated in the turn. View blocks:\n{}",
        crate::views::tool_spec()["description"].as_str().unwrap_or("").split_once("blocks: array of objects, each with a `type` and its fields:\n").map(|x| x.1).unwrap_or("")
    )
}

fn show_tool() -> Value {
    json!({
        "name": "show",
        "description": "The cards for this turn. Leave out anything that doesn't apply.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": { "type": "string" },
                "plan": { "type": "array", "items": { "type": "object", "properties": { "step": { "type": "string" }, "status": { "type": "string", "enum": ["done", "doing", "todo"] } }, "required": ["step", "status"] } },
                "view": { "type": "object", "properties": { "title": { "type": "string" }, "blocks": { "type": "array", "items": { "type": "object" } } }, "required": ["title", "blocks"] }
            }
        }
    })
}

/// What `show` gave back, checked against the catalog: the events to record.
pub fn events_from(input: &Value) -> Vec<(String, Value)> {
    let mut out = vec![];
    out.extend(input.get("title").and_then(|_| crate::views::validate_title(input).ok()).map(|t| ("session.titled".to_owned(), t)));
    out.extend(input.get("plan").and_then(|steps| crate::views::validate_plan(&json!({ "steps": steps })).ok()).map(|p| ("plan.updated".to_owned(), p)));
    out.extend(input.get("view").and_then(|v| crate::views::validate(v).ok()).map(|v| ("view.rendered".to_owned(), v)));
    for (_, p) in out.iter_mut() {
        p["by"] = "cockpit".into();
    }
    out
}

/// Whether this session was started with the layer on (it decides at start, like the compaction window).
pub fn session_uses_layer(app: &AppHandle, session: &str) -> bool {
    let evs = app.state::<crate::eventlog::EventLog>().list(Some(session), None, 100_000).unwrap_or_default();
    evs.iter().rev().find(|e| e.kind == "ui.session_requested").is_some_and(|e| e.payload["cockpit_layer"] == true)
}

/// After a turn ends: read it, ask the layer for cards, record them. Runs off the reader thread,
/// and only for sessions started with the layer on.
pub fn after_turn(app: AppHandle, session: String) {
    std::thread::spawn(move || {
        if !session_uses_layer(&app, &session) {
            return;
        }
        let evs = app.state::<crate::eventlog::EventLog>().list(Some(&session), None, 100_000).unwrap_or_default();
        let pairs: Vec<(String, Value)> = evs.iter().map(|e| (e.kind.clone(), e.payload.clone())).collect();
        let turn = turn_text(&pairs);
        if turn.trim().is_empty() {
            return;
        }
        let title = evs.iter().rev().find(|e| e.kind == "session.titled").and_then(|e| e.payload["title"].as_str().map(str::to_owned));
        let plan = evs.iter().rev().find(|e| e.kind == "plan.updated").map(|e| e.payload["steps"].clone());
        let prompt = format!("Current title: {}\nCurrent plan: {}\n\nThe turn:\n{turn}", title.as_deref().unwrap_or("(none)"), plan.map(|p| p.to_string()).unwrap_or_else(|| "(none)".into()));
        let body = json!({ "model": MODEL, "max_tokens": 3000, "system": system(), "messages": [{ "role": "user", "content": prompt }], "tools": [show_tool()], "tool_choice": { "type": "tool", "name": "show" } });
        let Ok(r) = call(&app, "render", Some(&session), body) else { return };
        let input = r["content"].as_array().into_iter().flatten().find(|b| b["type"] == "tool_use").map(|b| b["input"].clone()).unwrap_or(Value::Null);
        for (kind, p) in events_from(&input) {
            crate::eventlog::record(&app, Some(&session), &kind, &p, None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layer_is_off_until_switched_on() {
        assert!(!fold_on(&[]));
        assert!(fold_on(&[json!({ "on": true })]));
        assert!(!fold_on(&[json!({ "on": true }), json!({ "on": false })]));
    }

    #[test]
    fn costs_use_list_prices_with_cache_discounts() {
        let u = json!({ "input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_input_tokens": 1_000_000 });
        assert!((cost("claude-haiku-5-5", &u) - (1.0 + 0.5 + 0.1)).abs() < 1e-9);
    }

    #[test]
    fn the_turn_is_what_came_after_the_previous_result() {
        let a = |text: &str| ("sidecar.sdk".to_owned(), json!({ "message": { "type": "assistant", "message": { "content": [{ "type": "text", "text": text }, { "type": "tool_use", "name": "Bash", "input": { "command": "ls" } }] } } }));
        let result = ("sidecar.sdk".to_owned(), json!({ "message": { "type": "result" } }));
        let evs = vec![("ui.session_requested".to_owned(), json!({ "prompt": "first" })), a("old"), result.clone(), ("ui.message_sent".to_owned(), json!({ "text": "again" })), a("new"), result];
        let t = turn_text(&evs);
        assert!(t.contains("USER: again") && t.contains("CLAUDE: new") && t.contains("[tool Bash"));
        assert!(!t.contains("old") && !t.contains("first"));
    }

    #[test]
    fn only_catalog_cards_get_through() {
        let input = json!({ "title": "Fix login loop", "plan": [{ "step": "Read", "status": "done" }], "view": { "title": "Done", "blocks": [{ "type": "made_up" }] } });
        let evs = events_from(&input);
        assert_eq!(evs.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), ["session.titled", "plan.updated"]);
        assert_eq!(evs[0].1["by"], "cockpit");
        assert!(events_from(&Value::Null).is_empty());
    }
}
