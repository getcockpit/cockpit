//! Picker layer 2 (decision 5, MR-20): when plain code can't tell what a piece of agent prose is,
//! Cloudflare's Clef-flash decision model classifies it in one call (probabilities, no text).
//! Without credentials it falls back to the code rule, so nothing depends on the network.
//! Credentials live in the macOS Keychain, never in files.

use std::process::Command;
use std::time::Instant;

use serde_json::{json, Value};
use tauri::AppHandle;

const KEYCHAIN_SERVICE: &str = "minority-report.cloudflare";
pub const LABELS: [(&str, &str); 5] = [
    ("question", "Asks the user something and waits for their answer"),
    ("plan", "Proposes a plan or next steps before doing them"),
    ("done", "Reports finished work or a summary of what was done"),
    ("blocked", "Reports a failure, error or blocker it can't get past"),
    ("other", "Anything else"),
];

fn keychain_get(account: &str) -> Option<String> {
    let out = Command::new("security").args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|s| !s.is_empty())
}

fn creds() -> Option<(String, String)> {
    let account = std::env::var("CLOUDFLARE_ACCOUNT_ID").ok().or_else(|| keychain_get("account_id"))?;
    let token = std::env::var("CLOUDFLARE_API_TOKEN").ok().or_else(|| keychain_get("api_token"))?;
    Some((account, token))
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn layer2_save_credentials(account_id: String, api_token: String) -> Result<(), String> {
    for (acct, val) in [("account_id", account_id), ("api_token", api_token)] {
        let st = Command::new("security").args(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", acct, "-w", val.trim()]).status().map_err(|e| e.to_string())?;
        if !st.success() {
            return Err("couldn't save to the Keychain".into());
        }
    }
    Ok(())
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn layer2_status() -> Value {
    json!({ "configured": creds().is_some() })
}

/// The code-layer fallback: a turn ending in a question mark is a question.
pub fn rule(text: &str) -> &'static str {
    let last = text.trim().lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("").trim();
    if last.ends_with('?') { "question" } else { "other" }
}

/// Reads Clef's answer for one choice question, whatever exact shape it uses:
/// `{choice|answer|value: label, probabilities|distribution|options: {label: p}}` or `{label: p, …}`.
pub fn parse_choice(answer: &Value) -> Option<(String, f64, Value)> {
    let dist = ["probabilities", "distribution", "options", "scores"].iter().find_map(|k| answer.get(*k)).cloned().unwrap_or_else(|| answer.clone());
    let probs: Vec<(String, f64)> = dist.as_object()?.iter().filter_map(|(k, v)| v.as_f64().or_else(|| v.get("probability").and_then(Value::as_f64)).map(|p| (k.clone(), p))).collect();
    let named = ["choice", "answer", "value", "label"].iter().find_map(|k| answer.get(*k).and_then(Value::as_str)).map(str::to_owned);
    let best = probs.iter().cloned().max_by(|a, b| a.1.total_cmp(&b.1));
    let label = named.or_else(|| best.as_ref().map(|b| b.0.clone()))?;
    let p = probs.iter().find(|(k, _)| *k == label).map(|x| x.1).or(best.map(|b| b.1)).unwrap_or(0.0);
    Some((label, p, dist))
}

fn clef(account: &str, token: &str, text: &str) -> Result<(String, f64, Value), String> {
    let criteria: serde_json::Map<String, Value> = LABELS.iter().map(|(k, d)| ((*k).to_owned(), Value::from(*d))).collect();
    let body = json!({
        "model": "clef-flash",
        "state": text.chars().take(6000).collect::<String>(),
        "questions": { "kind": { "type": "choice", "instructions": "What is this message from a coding agent doing?", "criteria": criteria } }
    });
    let url = format!("https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef-flash");
    let resp: Value = ureq::post(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .send_json(&body)
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())?;
    let answers = resp.pointer("/result/answers").or_else(|| resp.get("answers")).ok_or_else(|| format!("unexpected response: {}", resp.to_string().chars().take(300).collect::<String>()))?;
    parse_choice(&answers["kind"]).ok_or_else(|| "no answer for kind".into())
}

/// Classifies one transcript item and records the render decision (layer, label, confidence,
/// latency, estimated tokens) as a `picker.layer2` event for the UI and god mode.
// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn layer2_classify(app: AppHandle, session: String, item_id: String, text: String) -> Value {
    let t0 = Instant::now();
    let tokens = (text.chars().count() / 4 + 120) as u64;
    let (label, p, layer, dist, error) = match creds() {
        Some((a, t)) => match clef(&a, &t, &text) {
            Ok((l, p, d)) => (l, p, "model", d, None),
            Err(e) => (rule(&text).to_owned(), 1.0, "code", Value::Null, Some(e)),
        },
        None => (rule(&text).to_owned(), 1.0, "code", Value::Null, None),
    };
    let payload = json!({ "item_id": item_id, "label": label, "p": p, "layer": layer, "dist": dist, "ms": t0.elapsed().as_millis() as u64, "tokens": if layer == "model" { tokens } else { 0 }, "error": error });
    crate::eventlog::record(&app, Some(&session), "picker.layer2", &payload, Some(&format!("render:{item_id}")));
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_plausible_answer_shapes() {
        let a = json!({ "choice": "question", "probabilities": { "question": 0.91, "plan": 0.05, "done": 0.04 } });
        assert_eq!(parse_choice(&a).map(|x| (x.0, x.1)), Some(("question".into(), 0.91)));
        let b = json!({ "question": 0.2, "plan": 0.7, "done": 0.1 });
        assert_eq!(parse_choice(&b).map(|x| x.0), Some("plan".into()));
        let c = json!({ "answer": "done", "distribution": { "done": { "probability": 0.8 }, "other": { "probability": 0.2 } } });
        assert_eq!(parse_choice(&c).map(|x| (x.0, x.1)), Some(("done".into(), 0.8)));
        assert!(parse_choice(&json!("nope")).is_none());
    }

    #[test]
    fn the_code_fallback_spots_questions() {
        assert_eq!(rule("Done.\nShould I also update the docs?"), "question");
        assert_eq!(rule("All tests pass."), "other");
    }
}
