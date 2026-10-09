//! Visual flows for the user's own commands (decision 19): /review and /pr-address keep running as
//! written, but report each step through `mr` tools so the app can draw it instead of printing text.
//! Each call becomes a `flow.*` event; the UI renders the latest state per session.

use serde_json::{json, Value};

pub fn tool_specs(kind: &str) -> Vec<Value> {
    match kind {
        "review" => vec![
            json!({ "name": "review_overview", "description": "Show the review overview (Step 5 of /review) visually instead of writing it out. tier: 1-3; tier_label: one clause; summary: 2-3 sentences; nodes: [{label, mark: '+'|'~'|'-', finding?: 'critical'|'important'|null}] for the change graph; novelty: [{label: 'net-new'|'adjacent'|'overlapping'|'duplicate', what, where?}]; questions: [string]; prior_threads: number of earlier review threads you checked; total_snippets: number.", "params": { "pr": "string", "title": "string", "tier": "number", "tier_label": "string", "summary": "string", "nodes": "array", "novelty": "array", "questions": "array", "prior_threads": "number", "total_snippets": "number" } }),
            json!({ "name": "review_snippet", "description": "Show one snippet of the walkthrough (Step 6 of /review). n and total: progress; area: concern group; title; file: 'path · start–end'; code: the trimmed diff with lines prefixed '+', '-' or ' '; explain: plain-language what and why; good: what's good; findings: [{id: 'f1', severity: 'Critical'|'Important'|'Suggestion'|'Nitpick', at: 'file:line', text}]. Then wait: the user replies 'note <id>', 'next', or asks a question.", "params": { "n": "number", "total": "number", "area": "string", "title": "string", "file": "string", "code": "string", "explain": "string", "good": "string", "findings": "array" } }),
            json!({ "name": "review_publish_ready", "description": "Show the consolidated review (Step 8 of /review): only the findings the user noted. comments: [{severity, at, text, suggestion?}]; verdict: 'Ship it'|'Needs changes'|'Needs discussion'|'Possibly redundant'; dropped: findings removed as duplicates of earlier threads. Then wait for the user to say 'publish'.", "params": { "comments": "array", "verdict": "string", "dropped": "number", "note": "string" } }),
        ],
        "address" => vec![
            json!({ "name": "address_threads", "description": "Show the list of review threads for the PR (pr-address steps 3-4). threads: [{id, at: 'file:line' or 'review body', reviewer, short: one line, state: 'already'|'open'|'fixed'|'deferred'}]. Call again whenever a thread's state changes.", "params": { "pr": "string", "round": "string", "moved_commits": "number", "threads": "array" } }),
            json!({ "name": "address_thread", "description": "Show the thread you are on now (pr-address step 5). verdict: 'addressed'|'not_addressed'; evidence_file: 'path · lines'; evidence_code: the relevant current code; options: [{id: 'A'|'B'|'skip', label, detail, recommended?: true}] when not addressed. Then wait for the user to pick an option.", "params": { "id": "string", "reviewer": "string", "at": "string", "body": "string", "verdict": "string", "evidence_file": "string", "evidence_code": "string", "options": "array" } }),
            json!({ "name": "address_proof", "description": "Show the verification checklist for the current fix (pr-address step 5d): checks: [{label, ok: true|false|null, proof}] e.g. builds, test actually ran, fails without the fix, hermetic scenario.", "params": { "id": "string", "checks": "array" } }),
            json!({ "name": "address_reply", "description": "Show the reply you are about to post (or posted) on a thread (pr-address step 5b/5e). posted: true once it's on GitHub.", "params": { "id": "string", "text": "string", "sha": "string", "posted": "boolean" } }),
        ],
        _ => vec![],
    }
}

pub fn system_prompt(kind: &str) -> Option<String> {
    let base = "You are running inside Minority report, a visual front-end for Claude Code. The user reads visuals, not text: keep every text reply to one short line and present each step through the mr tools described below. Never skip the tool calls; never repeat their content as text.";
    match kind {
        "review" => Some(format!("{base}\nFollow the /review command exactly, but: call review_overview instead of writing the Step 5 overview; call review_snippet for each Step 6 snippet and then wait for the user's reply ('note <finding id>', 'next', or a question); call review_publish_ready instead of writing the Step 8 consolidated list, and only publish to GitHub after the user says 'publish'.")),
        "address" => Some(format!("{base}\nFollow the pr-address skill exactly, but: call address_threads once you know the unresolved threads (and again whenever one changes state); for each thread call address_thread (with options and a recommendation when it isn't addressed) and wait for the user's choice; call address_proof with the verification results; call address_reply with each reply you post.")),
        _ => None,
    }
}

pub fn is_flow_tool(tool: &str) -> bool {
    tool.starts_with("review_") || tool.starts_with("address_")
}

/// Records the step; the answer tells Claude to wait when the step needs the user.
pub fn handle_tool(tool: &str, args: &Value) -> (Vec<(String, Value)>, String, bool) {
    let waits = matches!(tool, "review_snippet" | "review_publish_ready" | "address_thread");
    let text = if waits { "Shown to the user. Stop here and wait for their reply." } else { "Shown to the user." };
    (vec![(format!("flow.{tool}"), args.clone())], text.into(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flows_have_tools_and_instructions_only_for_their_kind() {
        assert_eq!(tool_specs("review").len(), 3);
        assert_eq!(tool_specs("address").len(), 4);
        assert!(tool_specs("blank").is_empty());
        assert!(system_prompt("review").unwrap().contains("review_snippet"));
        assert!(system_prompt("plan").is_none());
    }

    #[test]
    fn steps_become_flow_events_and_interactive_steps_ask_claude_to_wait() {
        let (events, text, err) = handle_tool("review_snippet", &json!({ "n": 1 }));
        assert_eq!(events[0].0, "flow.review_snippet");
        assert!(text.contains("wait") && !err);
        assert!(!handle_tool("review_overview", &json!({})).1.contains("wait"));
        assert!(is_flow_tool("address_proof") && !is_flow_tool("doc_read"));
    }
}
