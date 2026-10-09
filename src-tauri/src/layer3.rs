//! Picker layer 3 (decision 5, MR-21): a long plan or summary gets upgraded in the background to
//! a small flow diagram. The first render never waits on it. A Haiku one-shot through the official
//! SDK (no tools, unsaved) returns JSON nodes and edges, and the UI draws them with its own SVG
//! component. That keeps it cheap, and a bad answer simply means no diagram.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

const SYSTEM: &str = r#"You turn a coding agent's message into a small flow diagram. Reply with JSON only, no prose, no code fence:
{"title": "<= 6 words", "nodes": [{"id": "a", "label": "<= 6 words", "kind": "step|decision|done|risk"}], "edges": [{"from": "a", "to": "b", "label": "optional, <= 3 words"}]}
Use 3 to 10 nodes in the order things happen. Use "decision" for a choice the user must make, "risk" for a blocker or danger, and "done" for finished work. If the message has no flow worth drawing, reply {"nodes": []}."#;

const KINDS: [&str; 4] = ["step", "decision", "done", "risk"];

fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n { s.to_owned() } else { format!("{}…", s.chars().take(n - 1).collect::<String>().trim_end()) }
}

/// Pulls the diagram out of the model's reply and makes it safe to draw: unknown kinds become
/// steps, edges to missing nodes are dropped, and fewer than 2 nodes means "no diagram".
pub fn parse_diagram(reply: &str) -> Option<Value> {
    let (start, end) = (reply.find('{')?, reply.rfind('}')?);
    let v: Value = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let mut ids = HashSet::new();
    let nodes: Vec<Value> = v["nodes"].as_array()?.iter().take(12).filter_map(|n| {
        let id = n["id"].as_str()?.to_owned();
        let label = n["label"].as_str()?;
        if label.trim().is_empty() || !ids.insert(id.clone()) {
            return None;
        }
        let kind = n["kind"].as_str().filter(|k| KINDS.contains(k)).unwrap_or("step");
        Some(json!({ "id": id, "label": clip(label, 48), "kind": kind }))
    }).collect();
    if nodes.len() < 2 {
        return None;
    }
    let edges: Vec<Value> = v["edges"].as_array().map(|es| es.iter().filter_map(|e| {
        let (f, t) = (e["from"].as_str()?, e["to"].as_str()?);
        (f != t && ids.contains(f) && ids.contains(t)).then(|| json!({ "from": f, "to": t, "label": e["label"].as_str().map(|l| clip(l, 24)) }))
    }).take(24).collect()).unwrap_or_default();
    Some(json!({ "title": v["title"].as_str().map(|t| clip(t, 60)), "nodes": nodes, "edges": edges }))
}

/// Asks for a diagram of one transcript item. Returns at once; the answer lands later as a
/// `picker.layer3` event (with `diagram: null` when there's nothing worth drawing or it failed).
#[tauri::command]
pub fn layer3_diagram(app: AppHandle, session: String, item_id: String, text: String) {
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let prompt: String = text.chars().take(8000).collect();
        let (diagram, error) = match crate::sidecar::oneshot(&app, &prompt, SYSTEM, "haiku", Duration::from_secs(90)) {
            Ok(reply) => (parse_diagram(&reply), None),
            Err(e) => (None, Some(e)),
        };
        let payload = json!({ "item_id": item_id, "diagram": diagram, "ms": t0.elapsed().as_millis() as u64, "error": error });
        crate::eventlog::record(&app, Some(&session), "picker.layer3", &payload, Some(&format!("render:{item_id}")));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_clean_diagram_and_drops_bad_parts() {
        let reply = r#"Sure: {"title":"Ship the fix","nodes":[{"id":"a","label":"Reproduce","kind":"step"},{"id":"b","label":"Pick approach","kind":"decision"},{"id":"b","label":"dup"},{"id":"c","label":"Tests pass","kind":"weird"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c","label":"chosen"},{"from":"c","to":"zz"}]}"#;
        let d = parse_diagram(reply).unwrap();
        assert_eq!(d["nodes"].as_array().unwrap().len(), 3);
        assert_eq!(d["nodes"][1]["kind"], "decision");
        assert_eq!(d["nodes"][2]["kind"], "step");
        assert_eq!(d["edges"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn nothing_to_draw_means_none() {
        assert!(parse_diagram(r#"{"nodes": []}"#).is_none());
        assert!(parse_diagram("no json here").is_none());
        assert!(parse_diagram(r#"{"nodes":[{"id":"a","label":"only one"}]}"#).is_none());
    }
}
