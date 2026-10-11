//! Working documents (decision 12): app-owned docs made of /prd-section blocks. Every change is
//! an event (doc.*, ui.*) in the log; this module folds those events into current docs and answers
//! the `mr` MCP tools that Claude uses to create, read and update them.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

use crate::eventlog::Event;

pub const SECTIONS: [&str; 9] = ["goal", "scope", "success", "design", "risk", "question", "components", "verification", "log"];

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Block {
    pub id: String,
    pub section: String,
    pub status: String,
    pub takeaway: String,
    pub key: String,
    pub body: String,
    /// Structured content, e.g. `{"options":[{"label","description"}]}` for an open question.
    pub data: Value,
    pub order: i64,
    /// Set when the user decides an open question.
    pub decision: Option<String>,
    pub updated: String,
    /// The doc version this block last changed in, so a regenerate shows what moved (MR-51).
    #[serde(default)]
    pub since: i64,
    /// Its takeaway before that change, when the takeaway changed.
    #[serde(default)]
    pub was: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Doc {
    pub id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub version: i64,
    pub blocks: BTreeMap<String, Block>,
    /// Notes the user left that haven't been sent to Claude yet: (block_id, text).
    pub pending_notes: Vec<(String, String)>,
    /// User edits and decisions not yet sent to Claude.
    pub pending_changes: Vec<String>,
}

#[derive(Default)]
pub struct Docs {
    docs: Mutex<BTreeMap<String, Doc>>,
}

impl Docs {
    /// Folds one event into the docs. Unknown kinds are ignored; replaying the log rebuilds all docs.
    pub fn apply(&self, ev: &Event) {
        let mut docs = self.docs.lock().unwrap();
        apply_to(&mut docs, ev);
    }

    pub fn get(&self, id: &str) -> Option<Doc> {
        self.docs.lock().unwrap().get(id).cloned()
    }

    pub fn list(&self) -> Vec<Doc> {
        self.docs.lock().unwrap().values().cloned().collect()
    }
}

fn apply_to(docs: &mut BTreeMap<String, Doc>, ev: &Event) {
    let p = &ev.payload;
    let doc_id = p["doc_id"].as_str().unwrap_or_default().to_owned();
    match ev.kind.as_str() {
        "doc.created" => {
            docs.entry(doc_id.clone()).or_insert_with(|| Doc {
                id: doc_id,
                title: p["title"].as_str().unwrap_or("Untitled").to_owned(),
                session_id: ev.session_id.clone(),
                version: 1,
                ..Default::default()
            });
        }
        "doc.block_set" => {
            let Some(doc) = docs.get_mut(&doc_id) else { return };
            let block_id = p["block_id"].as_str().unwrap_or_default().to_owned();
            let prev = doc.blocks.get(&block_id).cloned().unwrap_or_default();
            let order = p["order"].as_i64().unwrap_or_else(|| if prev.order != 0 { prev.order } else { doc.blocks.len() as i64 + 1 });
            let s = |k: &str, old: &str| p[k].as_str().map(str::to_owned).unwrap_or_else(|| old.to_owned());
            doc.blocks.insert(
                block_id.clone(),
                Block {
                    id: block_id,
                    section: s("section", &prev.section),
                    status: s("status", &prev.status),
                    takeaway: s("takeaway", &prev.takeaway),
                    key: s("key", &prev.key),
                    body: s("body", &prev.body),
                    data: if p["data"].is_null() { prev.data } else { p["data"].clone() },
                    order,
                    decision: prev.decision.clone(),
                    updated: ev.id.clone(),
                    since: doc.version,
                    was: match p["takeaway"].as_str() {
                        Some(t) if !prev.takeaway.is_empty() && t != prev.takeaway => Some(prev.takeaway.clone()),
                        _ if prev.since == doc.version => prev.was.clone(),
                        _ => None,
                    },
                },
            );
        }
        "doc.block_removed" => {
            if let Some(doc) = docs.get_mut(&doc_id) {
                doc.blocks.remove(p["block_id"].as_str().unwrap_or_default());
            }
        }
        "doc.regenerated" => {
            if let Some(doc) = docs.get_mut(&doc_id) {
                doc.version += 1;
            }
        }
        "ui.doc_note" => {
            if let Some(doc) = docs.get_mut(&doc_id) {
                doc.pending_notes.push((p["block_id"].as_str().unwrap_or_default().into(), p["text"].as_str().unwrap_or_default().into()));
            }
        }
        "ui.doc_decision" => {
            let Some(doc) = docs.get_mut(&doc_id) else { return };
            let block_id = p["block_id"].as_str().unwrap_or_default();
            let choice = p["choice"].as_str().unwrap_or_default().to_owned();
            if let Some(b) = doc.blocks.get_mut(block_id) {
                b.decision = Some(choice.clone());
                b.status = "decided".into();
                doc.pending_changes.push(format!("Decided \"{}\": {}", b.takeaway, choice));
            }
        }
        "ui.doc_edit" => {
            let Some(doc) = docs.get_mut(&doc_id) else { return };
            let block_id = p["block_id"].as_str().unwrap_or_default();
            let field = p["field"].as_str().unwrap_or_default();
            let value = p["value"].as_str().unwrap_or_default().to_owned();
            if let Some(b) = doc.blocks.get_mut(block_id) {
                let before = match field {
                    "takeaway" => std::mem::replace(&mut b.takeaway, value.clone()),
                    "key" => std::mem::replace(&mut b.key, value.clone()),
                    "body" => std::mem::replace(&mut b.body, value.clone()),
                    _ => return,
                };
                doc.pending_changes.push(format!("Edited the {field} of block {block_id} from \"{before}\" to \"{value}\""));
            }
        }
        // Deleting a doc hides it: the log keeps its events, the fold drops it.
        "ui.doc_archived" => {
            docs.remove(&doc_id);
        }
        "ui.doc_feedback_sent" => {
            if let Some(doc) = docs.get_mut(&doc_id) {
                doc.pending_notes.clear();
                doc.pending_changes.clear();
            }
        }
        _ => {}
    }
}

/// The doc as Markdown, in /prd order, including the user's decisions and pending notes.
pub fn to_markdown(doc: &Doc) -> String {
    let mut out = format!("# {} (doc {}, v{})\n", doc.title, doc.id, doc.version);
    let mut blocks: Vec<&Block> = doc.blocks.values().collect();
    blocks.sort_by_key(|b| (SECTIONS.iter().position(|s| *s == b.section).unwrap_or(99), b.order));
    for b in blocks {
        out.push_str(&format!("\n## [{}] {} — {} (block {}, status: {})\n", b.section, b.takeaway, b.key, b.id, if b.status.is_empty() { "draft" } else { &b.status }));
        if !b.body.is_empty() {
            out.push_str(&format!("{}\n", b.body));
        }
        if let Some(opts) = b.data["options"].as_array() {
            for o in opts {
                out.push_str(&format!("- option: {} — {}\n", o["label"].as_str().unwrap_or_default(), o["description"].as_str().unwrap_or_default()));
            }
        }
        if let Some(d) = &b.decision {
            out.push_str(&format!("**Decided by the user: {d}**\n"));
        }
        for (_, text) in doc.pending_notes.iter().filter(|(id, _)| id == &b.id) {
            out.push_str(&format!("> User note: {text}\n"));
        }
    }
    out
}

/// The tool specs every session gets (relayed by the sidecar as the in-process `mr` MCP server).
pub fn tool_specs() -> Value {
    json!([
        { "name": "doc_create", "description": "Create a working document (a plan/spec the user reviews visually). Returns its doc_id. Use for any plan, spec or design before writing code.", "params": { "title": "string" } },
        { "name": "doc_set_block", "description": "Create or update one block of a working document. section is one of goal, scope, success, design, risk, question, components, verification, log. takeaway is one short line readable at a glance; key is one key detail; body is Markdown with the full content. For an open question the user must decide, use section=question and data={\"options\":[{\"label\":..,\"description\":..}]}, and never decide it yourself. Reuse block_id to update a block.", "params": { "doc_id": "string", "block_id": "string", "section": "string", "takeaway": "string", "key": "string", "body": "string", "status": "string", "data": "object" } },
        { "name": "doc_read", "description": "Read a working document as Markdown, including the user's decisions and notes. Read it before updating or implementing a doc.", "params": { "doc_id": "string" } },
        { "name": "doc_list", "description": "List the working documents with their ids and titles.", "params": {} }
    ])
}

/// Handles one relayed tool call. Returns (events to append, text answer, is_error).
pub fn handle_tool(docs: &Docs, session: Option<&str>, tool: &str, args: &Value) -> (Vec<(String, Value)>, String, bool) {
    let s = |k: &str| args[k].as_str().unwrap_or_default().to_owned();
    match tool {
        "doc_create" => {
            let id = format!("doc_{}", &ulid::Ulid::new().to_string()[..10].to_lowercase());
            let title = if s("title").is_empty() { "Untitled".into() } else { s("title") };
            (vec![("doc.created".into(), json!({ "doc_id": id, "title": title }))], format!("Created doc {id} \"{title}\". Add blocks with doc_set_block."), false)
        }
        "doc_set_block" => {
            let doc_id = s("doc_id");
            if docs.get(&doc_id).is_none() {
                return (vec![], format!("No doc {doc_id}. Create one with doc_create first."), true);
            }
            let section = s("section");
            if !SECTIONS.contains(&section.as_str()) {
                return (vec![], format!("Unknown section {section}. Use one of: {}.", SECTIONS.join(", ")), true);
            }
            let block_id = if s("block_id").is_empty() { format!("{section}_{}", &ulid::Ulid::new().to_string()[20..].to_lowercase()) } else { s("block_id") };
            let mut payload = json!({ "doc_id": doc_id, "block_id": block_id, "section": section });
            for k in ["takeaway", "key", "body", "status"] {
                if let Some(v) = args[k].as_str() {
                    payload[k] = v.into();
                }
            }
            if args["data"].is_object() {
                payload["data"] = args["data"].clone();
            }
            (vec![("doc.block_set".into(), payload)], format!("Saved block {block_id}."), false)
        }
        "doc_read" => match docs.get(&s("doc_id")) {
            Some(d) => (vec![], to_markdown(&d), false),
            None => (vec![], format!("No doc {}.", s("doc_id")), true),
        },
        "doc_list" => {
            let list: Vec<String> = docs.list().iter().map(|d| format!("{} — {} (v{}, {} blocks)", d.id, d.title, d.version, d.blocks.len())).collect();
            (vec![], if list.is_empty() { "No docs yet.".into() } else { list.join("\n") }, false)
        }
        _ => {
            let _ = session;
            (vec![], format!("Unknown tool {tool}."), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(n: u32, kind: &str, payload: Value) -> Event {
        Event { id: format!("E{n:04}"), session_id: Some("s1".into()), kind: kind.into(), payload, anchor: None, created_at: n as i64, origin: None }
    }

    fn run(docs: &Docs, n: &mut u32, tool: &str, args: Value) -> (String, bool) {
        let (events, text, err) = handle_tool(docs, Some("s1"), tool, &args);
        for (k, p) in events {
            *n += 1;
            docs.apply(&ev(*n, &k, p));
        }
        (text, err)
    }

    #[test]
    fn claude_builds_a_doc_and_reads_it_back_with_user_input() {
        let docs = Docs::default();
        let mut n = 0;
        let (text, _) = run(&docs, &mut n, "doc_create", json!({ "title": "Webhook retries" }));
        let id = text.split_whitespace().nth(2).unwrap().to_owned();
        run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "block_id": "goal", "section": "goal", "takeaway": "Every event lands once", "key": "5 retries", "body": "Details." }));
        run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "block_id": "q1", "section": "question", "takeaway": "How loud?", "key": "note 4", "data": { "options": [{ "label": "Post", "description": "quiet" }, { "label": "Page", "description": "loud" }] } }));
        n += 1;
        docs.apply(&ev(n, "ui.doc_decision", json!({ "doc_id": id, "block_id": "q1", "choice": "Page" })));
        n += 1;
        docs.apply(&ev(n, "ui.doc_note", json!({ "doc_id": id, "block_id": "goal", "text": "Cap at 5" })));
        let (md, err) = run(&docs, &mut n, "doc_read", json!({ "doc_id": id }));
        assert!(!err);
        assert!(md.contains("[goal] Every event lands once"), "{md}");
        assert!(md.contains("**Decided by the user: Page**"), "{md}");
        assert!(md.contains("> User note: Cap at 5"), "{md}");
        let doc = docs.get(&id).unwrap();
        assert_eq!(doc.pending_changes.len(), 1);
        assert_eq!(doc.blocks["q1"].status, "decided");
        // Goal comes before the question in /prd order.
        assert!(md.find("[goal]").unwrap() < md.find("[question]").unwrap());
    }

    #[test]
    fn updates_keep_unspecified_fields_and_bad_input_is_rejected() {
        let docs = Docs::default();
        let mut n = 0;
        let (text, _) = run(&docs, &mut n, "doc_create", json!({ "title": "T" }));
        let id = text.split_whitespace().nth(2).unwrap().to_owned();
        run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "block_id": "g", "section": "goal", "takeaway": "A", "key": "k" }));
        run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "block_id": "g", "section": "goal", "takeaway": "B" }));
        assert_eq!(docs.get(&id).unwrap().blocks["g"].key, "k");
        assert_eq!(docs.get(&id).unwrap().blocks["g"].takeaway, "B");
        assert!(run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "section": "nonsense" })).1);
        assert!(run(&docs, &mut n, "doc_set_block", json!({ "doc_id": "missing", "section": "goal" })).1);
    }

    #[test]
    fn a_regenerate_shows_which_blocks_changed_and_what_they_said_before() {
        let docs = Docs::default();
        let mut n = 0;
        let (text, _) = run(&docs, &mut n, "doc_create", json!({ "title": "T" }));
        let id = text.split_whitespace().nth(2).unwrap().to_owned();
        run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "block_id": "g", "section": "goal", "takeaway": "Export in a day" }));
        run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "block_id": "s", "section": "scope", "takeaway": "Invoices only" }));
        n += 1;
        docs.apply(&ev(n, "doc.regenerated", json!({ "doc_id": id })));
        run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "block_id": "g", "section": "goal", "takeaway": "Export in a minute" }));
        let d = docs.get(&id).unwrap();
        assert_eq!((d.version, d.blocks["g"].since, d.blocks["g"].was.as_deref()), (2, 2, Some("Export in a day")));
        assert_eq!((d.blocks["s"].since, d.blocks["s"].was.as_deref()), (1, None));
    }

    #[test]
    fn user_edits_are_tracked_until_feedback_is_sent() {
        let docs = Docs::default();
        let mut n = 0;
        let (text, _) = run(&docs, &mut n, "doc_create", json!({ "title": "T" }));
        let id = text.split_whitespace().nth(2).unwrap().to_owned();
        run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "block_id": "g", "section": "goal", "takeaway": "Old" }));
        n += 1;
        docs.apply(&ev(n, "ui.doc_edit", json!({ "doc_id": id, "block_id": "g", "field": "takeaway", "value": "New" })));
        assert_eq!(docs.get(&id).unwrap().blocks["g"].takeaway, "New");
        assert_eq!(docs.get(&id).unwrap().pending_changes.len(), 1);
        n += 1;
        docs.apply(&ev(n, "ui.doc_feedback_sent", json!({ "doc_id": id })));
        assert!(docs.get(&id).unwrap().pending_changes.is_empty());
    }

    #[test]
    fn an_archived_doc_is_gone_and_later_writes_to_it_are_ignored() {
        let docs = Docs::default();
        let mut n = 0;
        let (text, _) = run(&docs, &mut n, "doc_create", json!({ "title": "T" }));
        let id = text.split_whitespace().nth(2).unwrap().to_owned();
        n += 1;
        docs.apply(&ev(n, "ui.doc_archived", json!({ "doc_id": id })));
        assert!(docs.get(&id).is_none());
        assert!(docs.list().is_empty());
        assert!(run(&docs, &mut n, "doc_set_block", json!({ "doc_id": id, "section": "goal", "takeaway": "A" })).1);
        assert!(docs.get(&id).is_none());
    }
}

#[tauri::command]
pub fn docs_list(docs: tauri::State<'_, Docs>) -> Vec<Doc> {
    docs.list()
}

/// Deletes a working doc for the user. The log is append-only, so it's hidden, not erased.
#[tauri::command]
pub fn doc_archive(app: tauri::AppHandle, docs: tauri::State<'_, Docs>, doc_id: String) -> Result<(), String> {
    let doc = docs.get(&doc_id).ok_or("no such doc")?;
    crate::eventlog::record(&app, doc.session_id.as_deref(), "ui.doc_archived", &json!({ "doc_id": doc.id, "title": doc.title }), Some(&format!("doc:{}", doc.id)));
    Ok(())
}

/// Turns the user's pending notes, decisions and edits into one message for Claude, logs that it
/// was sent, and (for Regenerate) bumps the version. The UI sends the text to the doc's session.
#[tauri::command]
pub fn doc_feedback(app: tauri::AppHandle, docs: tauri::State<'_, Docs>, doc_id: String, regenerate: bool) -> Result<String, String> {
    let doc = docs.get(&doc_id).ok_or("no such doc")?;
    let mut msg = format!("Feedback on working doc \"{}\" ({}).\n", doc.title, doc.id);
    if !doc.pending_changes.is_empty() {
        msg.push_str("\nThe user changed:\n");
        for c in &doc.pending_changes {
            msg.push_str(&format!("- {c}\n"));
        }
    }
    if !doc.pending_notes.is_empty() {
        msg.push_str("\nThe user's notes, each tied to a block:\n");
        for (block, text) in &doc.pending_notes {
            let what = doc.blocks.get(block).map(|b| b.takeaway.as_str()).unwrap_or(block);
            msg.push_str(&format!("- on [{block}] \"{what}\": {text}\n"));
        }
    }
    msg.push_str(if regenerate {
        "\nRead the doc with doc_read, then update it with doc_set_block to address every note and decision: change the affected blocks, add a [log] block summarising what changed in this version, and keep decided questions decided. Don't write code."
    } else {
        "\nTake this into account in your current work."
    });
    let session = doc.session_id.clone();
    crate::eventlog::record(&app, session.as_deref(), "ui.doc_feedback_sent", &json!({ "doc_id": doc.id, "regenerate": regenerate }), Some(&format!("doc:{}", doc.id)));
    if regenerate {
        crate::eventlog::record(&app, session.as_deref(), "doc.regenerated", &json!({ "doc_id": doc.id }), Some(&format!("doc:{}", doc.id)));
    }
    Ok(msg)
}
