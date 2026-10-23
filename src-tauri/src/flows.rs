//! Visual flows for the user's own commands (decision 19): /review and /pr-address keep running as
//! written, but report each step through `mr` tools so the app can draw it instead of printing text.
//! Each call becomes a `flow.*` event; the UI renders the latest state per session.

use serde_json::{json, Value};

pub fn tool_specs(kind: &str) -> Vec<Value> {
    match kind {
        "review" => vec![
            json!({ "name": "review_unchanged", "description": "Show that nothing happened on the PR since the user's last review, so there is nothing to review again (the check that runs before anything else). pr: '#n'; title; last_review_at: when they last reviewed it (ISO); last_review_state: 'APPROVED'|'CHANGES_REQUESTED'|'COMMENTED'; checked: what you compared, one short line like 'no commits, comments or replies since'. Then stop: don't review. The user may reply 'review anyway'.", "params": { "pr": "string", "title": "string", "last_review_at": "string", "last_review_state": "string", "checked": "string" } }),
            json!({ "name": "review_overview", "description": "Show the review overview (Step 5 of /review) visually instead of writing it out. tier: 1-3; tier_label: one clause; summary: 2-3 sentences; nodes and edges are the Step 5 architecture/flow DAG as data, not ASCII: nodes: [{id: 'n1', label: 1-4 words, mark: '+'|'~'|'-', finding?: 'critical'|'important'|null}], one per box; edges: [{from: node id, to: node id, label?: 1-2 words like 'calls' or 'writes'}], one per arrow, so every node is connected to the flow; novelty: [{label: 'net-new'|'adjacent'|'overlapping'|'duplicate', what, where?}]; questions: [string]; prior_threads: number of earlier review threads you checked; total_snippets: number.", "params": { "pr": "string", "title": "string", "tier": "number", "tier_label": "string", "summary": "string", "nodes": "array", "edges": "array", "novelty": "array", "questions": "array", "prior_threads": "number", "total_snippets": "number" } }),
            json!({ "name": "review_snippet", "description": "Show one snippet of the walkthrough (Step 6 of /review). n and total: progress; area: concern group; title; file: 'path · start–end'; code: the trimmed diff with lines prefixed '+', '-' or ' '; explain: plain-language what and why; good: what's good; findings: [{id: 'f1', severity: 'Critical'|'Important'|'Suggestion'|'Nitpick', at: 'file:line', text}]. Then wait: the user replies 'note <id>', 'unnote <id>' (take it back out), 'next', 'snippet <n>' (jump to snippet n, in either direction), or asks a question.", "params": { "n": "number", "total": "number", "area": "string", "title": "string", "file": "string", "code": "string", "explain": "string", "good": "string", "findings": "array" } }),
            json!({ "name": "review_publish_ready", "description": "Show the consolidated review (Step 8 of /review): only the findings the user noted. comments: [{severity, at, text, suggestion?}]; verdict: 'Ship it'|'Needs changes'|'Needs discussion'|'Possibly redundant'; dropped: findings removed as duplicates of earlier threads. Then wait for the user to say 'publish'.", "params": { "comments": "array", "verdict": "string", "dropped": "number", "note": "string" } }),
            json!({ "name": "review_published", "description": "Report that the review is on GitHub (every noted comment posted as one review). Call it only after gh confirms the post. pr: '#n'; url: the review's URL; comments: how many were posted; approved: true if it went out with event APPROVE. Cockpit then archives this session by itself: end your turn with no text.", "params": { "pr": "string", "url": "string", "comments": "number", "approved": "boolean" } }),
        ],
        "address" => vec![
            json!({ "name": "address_threads", "description": "Show the list of review threads for the PR (pr-address steps 3-4). threads: [{id, at: 'file:line' or 'review body', reviewer, short: one line, state: 'already'|'open'|'fixed'|'deferred'}]. Call again whenever a thread's state changes.", "params": { "pr": "string", "round": "string", "moved_commits": "number", "threads": "array" } }),
            json!({ "name": "address_thread", "description": "Draw one thread's analysis (pr-address step 5a). Draw every thread that isn't already addressed up front, one call after another, before fixing anything: the user reads and decides on all of them at once. verdict: 'addressed'|'not_addressed' plus why; evidence_file: 'path · lines'; evidence_code: the relevant current code; options: [{id: 'A'|'B'|'skip', label, detail, recommended?: true}] when not addressed. Don't wait between threads.", "params": { "id": "string", "reviewer": "string", "at": "string", "body": "string", "verdict": "string", "evidence_file": "string", "evidence_code": "string", "options": "array" } }),
            json!({ "name": "address_fixing", "description": "Say which thread you are working on now (pr-address step 5c), the moment you start applying the user's choice for it.", "params": { "id": "string" } }),
            json!({ "name": "address_proof", "description": "Show the verification checklist for the current fix (pr-address step 5d): checks: [{label, ok: true|false|null, proof}] e.g. builds, test actually ran, fails without the fix, hermetic scenario.", "params": { "id": "string", "checks": "array" } }),
            json!({ "name": "address_reply", "description": "Show the reply you are about to post (or posted) on a thread (pr-address step 5b/5e). posted: true once it's on GitHub.", "params": { "id": "string", "text": "string", "sha": "string", "posted": "boolean" } }),
            json!({ "name": "address_done", "description": "Show that every thread is handled (pr-address wrap-up): summary: one line of what changed; pushed: true once the fixes are pushed and every reply is posted (Cockpit then archives this session by itself, so end your turn with no text); next: 1-3 next steps for the user, best first, [{label: short imperative like 'Push and re-request review from @dana', reply: the exact message to send you to do it}]. Then wait for the user.", "params": { "summary": "string", "pushed": "boolean", "next": "array" } }),
        ],
        _ => vec![],
    }
}

pub fn system_prompt(kind: &str) -> Option<String> {
    let base = "You are running inside Cockpit, a visual front-end for Claude Code. The user reads visuals, not text: keep every text reply to one short line and present each step through the mr tools described below. Never skip the tool calls; never repeat their content as text.";
    match kind {
        "review" => Some(format!("{base}\nBefore anything else, check for new developments since the user's last review of this PR: their login (`gh api user -q .login`), their newest submitted review on it (`gh api repos/{{owner}}/{{repo}}/pulls/{{n}}/reviews --paginate`), then whether anything came after it: commits (the head sha differs from that review's commit_id, or a commit is newer than its submitted_at), or reviews, review comments or issue comments by anyone else since its submitted_at. If they reviewed it before and nothing is new, call review_unchanged and stop: no overview, no walkthrough, nothing posted. If they never reviewed it, or something is new, carry on, and when there was an earlier review, start the overview summary with what changed since. If they reply 'review anyway', run the full review.\nFollow the /review command exactly, but: call review_overview instead of writing the Step 5 overview; call review_snippet for each Step 6 snippet and then wait for the user's reply ('note <finding id>', 'unnote <finding id>' to drop a noted finding, 'Remove this from the review: …' to drop a raised overview point, 'next', 'snippet <n>' to jump straight to snippet n, forward or back, then carry on from there, or a question); call review_publish_ready instead of writing the Step 8 consolidated list, and only publish to GitHub after the user says 'publish', and once it is posted call review_published: Cockpit archives the session, nothing is left for the user. If they say 'publish and approve' instead, post the same single review with event APPROVE rather than COMMENT, approving the PR on their behalf; never approve on plain 'publish'.")),
        "address" => Some(format!("{base}\nFollow the pr-address skill exactly, but: call address_threads once you know the unresolved threads (and again whenever one changes state). Then analyse every thread up front: call address_thread for each one, back to back without waiting (with options and a recommendation when it isn't addressed), and only then stop and wait. The user decides in any order with replies like 'Thread <id> · Option <id>: <label>', several at once if they like, or 'Thread <id> · My own answer: <text>' when they write their own fix or reply instead of picking one: treat it exactly like a picked option. Any other message (for example 'About thread <id>: …') is a question: answer it, digging into the code, the thread and your reasoning as deep as it asks, and act on no thread until a choice arrives. For each choice, in the order they arrive: call address_fixing, apply it, call address_proof with the verification results, call address_reply with the reply you post. When every thread is handled, call address_done with the next steps; when the fixes are pushed and every reply is posted, nothing is left for the user, so set pushed: true and Cockpit archives the session.")),
        _ => None,
    }
}

/// The PR is fully handled, so the session archives itself (no waiting for the user): the review is
/// published, or every reply is posted and the fixes are pushed.
pub fn closes_session(tool: &str, args: &Value) -> bool {
    tool == "review_published" || (tool == "address_done" && args["pushed"] == true)
}

pub fn is_flow_tool(tool: &str) -> bool {
    tool.starts_with("review_") || tool.starts_with("address_")
}

/// Records the step; the answer tells Claude to wait when the step needs the user.
pub fn handle_tool(tool: &str, args: &Value) -> (Vec<(String, Value)>, String, bool) {
    let waits = matches!(tool, "review_snippet" | "review_publish_ready" | "address_done");
    let text = if closes_session(tool, args) {
        "Shown to the user. Everything is done: Cockpit archives this session now. End your turn with no text."
    } else if waits {
        "Shown to the user. Stop here and wait for their reply."
    } else if tool == "address_thread" {
        "Shown to the user. Draw the next thread now if any are left; once every thread is drawn, stop and wait for their choices."
    } else {
        "Shown to the user."
    };
    (vec![(format!("flow.{tool}"), args.clone())], text.into(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flows_have_tools_and_instructions_only_for_their_kind() {
        assert_eq!(tool_specs("review").len(), 5);
        assert_eq!(tool_specs("address").len(), 6);
        assert!(tool_specs("blank").is_empty());
        assert!(system_prompt("review").unwrap().contains("review_snippet"));
        assert!(system_prompt("review").unwrap().contains("'snippet <n>'"));
        assert!(system_prompt("review").unwrap().contains("'publish and approve'"));
        // Nothing new since your last review: Claude says so instead of reviewing again.
        assert!(system_prompt("review").unwrap().contains("call review_unchanged and stop"));
        assert!(system_prompt("review").unwrap().contains("'review anyway'"));
        assert!(system_prompt("plan").is_none());
    }

    #[test]
    fn steps_become_flow_events_and_interactive_steps_ask_claude_to_wait() {
        let (events, text, err) = handle_tool("review_snippet", &json!({ "n": 1 }));
        assert_eq!(events[0].0, "flow.review_snippet");
        assert!(text.contains("wait") && !err);
        assert!(!handle_tool("review_overview", &json!({})).1.contains("wait"));
        assert_eq!(handle_tool("review_unchanged", &json!({})).0[0].0, "flow.review_unchanged");
        // The overview's change graph is a DAG: the tool takes its arrows, not just its boxes.
        let ov = tool_specs("review").into_iter().find(|t| t["name"] == "review_overview").unwrap();
        assert!(ov["params"]["edges"] == "array" && ov["description"].as_str().unwrap().contains("one per arrow"));
        assert!(is_flow_tool("address_proof") && !is_flow_tool("doc_read"));
    }

    #[test]
    fn address_draws_every_thread_before_waiting() {
        // A thread no longer stops the turn: the next one is drawn straight away (MR-126).
        let (_, text, _) = handle_tool("address_thread", &json!({ "id": "t1" }));
        assert!(text.contains("next thread") && !text.contains("Stop here"));
        assert!(handle_tool("address_done", &json!({})).1.contains("wait"));
        assert!(system_prompt("address").unwrap().contains("back to back"));
    }

    #[test]
    fn a_published_review_or_pushed_address_closes_the_session() {
        // Nothing is left for the user, so the session archives itself instead of waiting.
        assert!(closes_session("review_published", &json!({ "pr": "#1" })));
        assert!(closes_session("address_done", &json!({ "pushed": true })));
        assert!(!closes_session("address_done", &json!({ "pushed": false })));
        assert!(!closes_session("review_publish_ready", &json!({})));
        let (events, text, _) = handle_tool("review_published", &json!({ "pr": "#1" }));
        assert_eq!(events[0].0, "flow.review_published");
        assert!(text.contains("archives") && !text.contains("wait"));
        assert!(handle_tool("address_done", &json!({ "pushed": false })).1.contains("wait"));
        assert!(system_prompt("review").unwrap().contains("call review_published"));
    }
}
