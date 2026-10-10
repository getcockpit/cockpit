//! Views Claude composes from the component catalog (decision 26, MR-61). `render_view` takes a
//! title and a list of catalog blocks; the core checks each block against the catalog and either
//! records a `view.rendered` event (the UI draws it inline in the transcript) or answers with what
//! to fix, so Claude can call again. Nothing outside the catalog can be drawn.

use serde_json::{json, Value};

pub const TOOL: &str = "render_view";
/// Claude's plan for the current work (MR-62). Claude Code no longer offers TodoWrite to SDK
/// sessions, so the app owns the plan: the Plan panel, the progress tracks and the tiles read it.
pub const PLAN: &str = "plan_set";
/// The thread's title, kept current by Claude (MR-63): what this thread is about, in a few words.
pub const TITLE: &str = "title_set";

/// Field kinds a block can require.
#[derive(Clone, Copy)]
enum F {
    Str,
    Num,
    List,
}

/// The catalog blocks Claude may use: type → required fields. Optional fields are listed in the
/// tool description and passed through as given.
const CATALOG: &[(&str, &[(&str, F)])] = &[
    ("takeaway", &[("heading", F::Str), ("items", F::List)]),
    ("tally", &[("items", F::List)]),
    ("checklist", &[("items", F::List)]),
    ("progress", &[("n", F::Num), ("total", F::Num), ("label", F::Str)]),
    ("compare", &[("criteria", F::List), ("rows", F::List)]),
    ("change_graph", &[("nodes", F::List)]),
    ("snippet", &[("code", F::Str)]),
    ("next", &[("text", F::Str)]),
    ("findings", &[("items", F::List)]),
    ("tier", &[("tier", F::Num), ("label", F::Str)]),
    ("novelty", &[("items", F::List)]),
    ("tradeoff", &[("points", F::List)]),
    ("fix_options", &[("options", F::List)]),
    ("thread", &[("author", F::Str), ("body", F::Str)]),
    ("text", &[("markdown", F::Str)]),
];

pub fn tool_spec() -> Value {
    json!({
        "name": TOOL,
        "description": "Show the user a view built from the app's component catalog, instead of writing a report, summary, comparison, status or verification result as text. Make it the last call of the turn and add no text after it. title: short heading. blocks: array of objects, each with a `type` and its fields:\n\
- takeaway {heading, status?: 'done'|'todo'|'you'|'info', items: [{title, detail?, state?: 'done'|'todo'|'you'|'error', time?: 'about 15 min'}]}: a section with state-marked rows. 'you' = needs the user.\n\
- tally {items: [{n, label, tone?: 'done'|'now'|'deferred'|'todo'|'error'}]}: a batch of outcomes as one bar.\n\
- checklist {items: [{label, ok: true|false|null, proof?}]}: verification; null = still running.\n\
- progress {n, total, label, right?}: where you are in a sequence ('Step 3 of 7').\n\
- compare {criteria: [string], rows: [{option, values: [string], recommended?: true}]}: options as rows, criteria as columns.\n\
- change_graph {nodes: [{label, mark: '+'|'~'|'-'}]}: what a change touches, in flow order.\n\
- snippet {file?, code, note?}: only the lines that matter; prefix diff lines with '+', '-' or ' '.\n\
- next {text, replies?: [string]}: the suggested next move, with 1-3 one-click replies the user can send.\n\
- findings {items: [{severity: 'critical'|'important'|'suggestion'|'nitpick', title, where?: 'file.ts:42'}]}: review findings on the severity scale, most severe first.\n\
- tier {tier: 1|2|3, label, detail?}: what's at stake, first. 1 = blocker, customers feel it; 2 = leverage, nothing on fire; 3 = housekeeping.\n\
- novelty {items: [{verdict: 'new'|'adjacent'|'overlapping'|'duplicate', what, where?}]}: does this already exist, per capability.\n\
- tradeoff {points: [{x, y}], x_unit?, y_unit?, label?, pick?: x}: when the answer is a number, what each value buys; the user drags and can send 'Use <x>'.\n\
- fix_options {finding?, options: [{label, detail?, recommended?: true}], defer?: false}: concrete fixes for one finding; clicking one sends it as a reply. A defer row is added unless defer is false.\n\
- thread {author, body, state?: 'unresolved'|'replied'|'resolved', where?, note?}: a reviewer comment with its real state; a reply is not a resolution.\n\
- text {markdown}: a short paragraph, only when no other block fits.\n\
Every block except next and text carries Deeper / Discover actions. Use AskUserQuestion, not render_view, for any other choice the user must make.",
        "params": { "title": "string", "blocks": "array" },
        "always_load": true
    })
}

pub fn plan_spec() -> Value {
    json!({
        "name": PLAN,
        "description": "Publish your plan for the current work so the user can follow it (the app shows it as a plan with progress). Call it before starting any work with 3 or more steps, and again every time a step starts or finishes, always with the full list. steps: [{step: short imperative ('Migrate the readers'), status: 'done'|'doing'|'todo'}]; exactly one step is 'doing' while you work. Add or drop steps when the plan changes. Don't repeat the plan as text.",
        "params": { "steps": "array" },
        "always_load": true
    })
}

pub fn title_spec() -> Value {
    json!({
        "name": TITLE,
        "description": "Name this thread for the user's wall: 2-6 words saying what it is about now (e.g. 'Plan panel for live progress', 'Fix login redirect loop'). Call it when the thread starts and again whenever its focus clearly shifts. Sentence case, no quotes or trailing period. Don't mention it in text.",
        "params": { "title": "string" },
        "always_load": true
    })
}

pub fn is_view_tool(tool: &str) -> bool {
    tool == TOOL || tool == PLAN || tool == TITLE
}

/// A short title: trimmed, unquoted, one line, at most 60 characters.
pub fn validate_title(args: &Value) -> Result<Value, String> {
    let t = args["title"].as_str().unwrap_or("").lines().next().unwrap_or("").trim().trim_matches(|c| c == '"' || c == '\'' || c == '.').trim();
    if t.is_empty() {
        return Err("Title not set: 'title' must be a non-empty string of 2-6 words.".into());
    }
    if t.chars().count() > 60 {
        return Err(format!("Title not set: '{t}' is too long; use 2-6 words (at most 60 characters)."));
    }
    Ok(json!({ "title": t }))
}

/// Checks a plan. Ok: the event payload. Err: what to fix.
pub fn validate_plan(args: &Value) -> Result<Value, String> {
    let steps = args["steps"].as_array().filter(|s| !s.is_empty()).ok_or("steps must be a non-empty array of {step, status}")?;
    let mut errors = vec![];
    for (i, s) in steps.iter().enumerate() {
        if !s["step"].as_str().is_some_and(|x| !x.trim().is_empty()) {
            errors.push(format!("steps[{i}]: 'step' must be a non-empty string"));
        }
        if !matches!(s["status"].as_str(), Some("done" | "doing" | "todo")) {
            errors.push(format!("steps[{i}]: 'status' must be 'done', 'doing' or 'todo'"));
        }
    }
    if !errors.is_empty() {
        return Err(format!("Plan not updated. Fix and call plan_set again:\n{}", errors.join("\n")));
    }
    let steps: Vec<Value> = steps.iter().map(|s| json!({ "step": s["step"].as_str().unwrap_or("").trim(), "status": s["status"] })).collect();
    Ok(json!({ "steps": steps }))
}

/// Checks every block against the catalog. Ok: the event to record. Err: what to fix, per block.
pub fn validate(args: &Value) -> Result<Value, String> {
    let blocks = args["blocks"].as_array().filter(|b| !b.is_empty()).ok_or("blocks must be a non-empty array of catalog blocks")?;
    let mut errors = vec![];
    for (i, b) in blocks.iter().enumerate() {
        let ty = b["type"].as_str().unwrap_or("");
        let Some((_, fields)) = CATALOG.iter().find(|(name, _)| *name == ty) else {
            let known: Vec<&str> = CATALOG.iter().map(|(n, _)| *n).collect();
            errors.push(format!("blocks[{i}]: unknown type '{ty}' (use one of: {})", known.join(", ")));
            continue;
        };
        for (field, kind) in fields.iter() {
            let v = &b[*field];
            let ok = match kind {
                F::Str => v.as_str().is_some_and(|s| !s.trim().is_empty()),
                F::Num => v.is_number(),
                F::List => v.as_array().is_some_and(|a| !a.is_empty()),
            };
            if !ok {
                let want = match kind { F::Str => "a non-empty string", F::Num => "a number", F::List => "a non-empty array" };
                errors.push(format!("blocks[{i}] ({ty}): '{field}' must be {want}"));
            }
        }
    }
    if !errors.is_empty() {
        return Err(format!("Not shown. Fix and call render_view again:\n{}", errors.join("\n")));
    }
    Ok(json!({ "title": args["title"].as_str().unwrap_or(""), "blocks": blocks }))
}

pub fn handle_tool(tool: &str, args: &Value) -> (Vec<(String, Value)>, String, bool) {
    if tool == TITLE {
        return match validate_title(args) {
            Ok(title) => (vec![("session.titled".into(), title)], "Title set.".into(), false),
            Err(e) => (vec![], e, true),
        };
    }
    if tool == PLAN {
        return match validate_plan(args) {
            Ok(plan) => (vec![("plan.updated".into(), plan)], "Plan updated.".into(), false),
            Err(e) => (vec![], e, true),
        };
    }
    match validate(args) {
        Ok(view) => (vec![("view.rendered".into(), view)], "Shown. End the turn here.".into(), false),
        Err(e) => (vec![], e, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_views_become_events() {
        let (events, text, err) = handle_tool(TOOL, &json!({ "title": "Status", "blocks": [
            { "type": "tally", "items": [{ "n": 3, "label": "fixed", "tone": "done" }] },
            { "type": "progress", "n": 2, "total": 5, "label": "Migrating readers" },
        ] }));
        assert!(!err && text.contains("Shown"));
        assert_eq!(events[0].0, "view.rendered");
        assert_eq!(events[0].1["blocks"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn invalid_blocks_explain_what_to_fix_and_record_nothing() {
        let (events, text, err) = handle_tool(TOOL, &json!({ "blocks": [
            { "type": "chart", "data": [] },
            { "type": "progress", "n": "two", "label": "" },
        ] }));
        assert!(err && events.is_empty());
        assert!(text.contains("unknown type 'chart'"));
        assert!(text.contains("'n' must be a number") && text.contains("'total' must be a number") && text.contains("'label' must be a non-empty string"));
        assert!(handle_tool(TOOL, &json!({ "blocks": [] })).2);
    }

    #[test]
    fn plans_become_events_and_bad_steps_explain_themselves() {
        let (events, _, err) = handle_tool(PLAN, &json!({ "steps": [{ "step": " Read the code ", "status": "done" }, { "step": "Fix it", "status": "doing" }] }));
        assert!(!err && events[0].0 == "plan.updated");
        assert_eq!(events[0].1["steps"][0]["step"], "Read the code");
        let (events, text, err) = handle_tool(PLAN, &json!({ "steps": [{ "step": "", "status": "started" }] }));
        assert!(err && events.is_empty() && text.contains("'step'") && text.contains("'status'"));
        assert!(is_view_tool(PLAN) && is_view_tool(TOOL) && !is_view_tool("doc_read"));
    }

    #[test]
    fn titles_are_trimmed_and_bounded() {
        let (events, _, err) = handle_tool(TITLE, &json!({ "title": " \"Plan panel for live progress.\" \nextra" }));
        assert!(!err && events[0].0 == "session.titled");
        assert_eq!(events[0].1["title"], "Plan panel for live progress");
        assert!(handle_tool(TITLE, &json!({ "title": "  " })).2);
        assert!(handle_tool(TITLE, &json!({ "title": "x".repeat(61) })).2);
    }

    #[test]
    fn designed_blocks_validate() {
        let (events, _, err) = handle_tool(TOOL, &json!({ "title": "Review", "blocks": [
            { "type": "tier", "tier": 2, "label": "Leverage" },
            { "type": "findings", "items": [{ "severity": "critical", "title": "Typed nil" }] },
            { "type": "novelty", "items": [{ "verdict": "duplicate", "what": "slug resolver" }] },
            { "type": "tradeoff", "points": [{ "x": 1, "y": 40 }, { "x": 2, "y": 81 }] },
            { "type": "fix_options", "options": [{ "label": "Guard the nil", "recommended": true }] },
            { "type": "thread", "author": "marta", "body": "This can return a typed nil." },
        ] }));
        assert!(!err && events.len() == 1);
        let (_, text, err) = handle_tool(TOOL, &json!({ "blocks": [{ "type": "tier", "label": "x" }, { "type": "thread", "author": "marta" }] }));
        assert!(err && text.contains("'tier' must be a number") && text.contains("'body' must be a non-empty string"));
    }

    #[test]
    fn the_spec_lists_every_catalog_block() {
        let d = tool_spec()["description"].as_str().unwrap().to_owned();
        for (name, _) in CATALOG {
            assert!(d.contains(&format!("- {name} {{")), "{name} missing from the description");
        }
    }

    #[test]
    fn harness_tools_skip_tool_search() {
        for spec in [tool_spec(), plan_spec(), title_spec()] {
            assert_eq!(spec["always_load"], true, "{} would cost a ToolSearch round trip", spec["name"]);
        }
    }
}
