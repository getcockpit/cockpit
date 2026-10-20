//! `session_spawn` (MR-176): a session starts another Cockpit session, with no approval. The parent
//! picks the folder, the workspace and whether the child gets its own worktree. One level only: a
//! spawned session isn't offered the tool, and a call from one is refused. The session cap applies.
//! Each turn the child finishes goes back to the parent as a message: at once if the parent is
//! running, else in front of your next message to it.
//! A child can be a Review or Address session (MR-181), started the way the start picker does, so a
//! recurring "open PRs" run gets the review flow and not a plain session.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager};

/// Running children → (parent, prompt), for reporting back without reading the log every turn.
static PARENTS: LazyLock<Mutex<HashMap<String, (String, String)>>> = LazyLock::new(Default::default);

/// A report longer than this is cut: the parent can open the child for the rest.
const REPORT_MAX: usize = 6000;

pub const TOOL: &str = "session_spawn";

pub fn tool_spec() -> Value {
    json!({
        "name": TOOL,
        "description": "Start another Cockpit session that works on its own, in parallel, and shows on the user's Wall (no approval needed). Use it for independent work that deserves its own thread, not for quick lookups (use subagents for those). prompt: the full task, self-contained; the new session doesn't see this conversation. cwd: the folder it works in (default: yours; relative paths are from yours). worktree: true (default) gives it its own git worktree and branch off cwd's repo, false runs it in cwd as is, sharing the checkout. workspace: a workspace id or name (default: yours; 'personal' is the default workspace); an unknown one returns the list. Returns the new session's id. Whenever the new session finishes a turn, its final reply comes back to you as a message starting '[Report from spawned session', so don't wait or poll for it: end your turn when you have nothing else to do. Spawned sessions can't spawn more. The session cap still applies. kind: 'blank' (default), 'review' or 'address'. To review a pull request use kind 'review' with prompt '/review <PR number or URL>' and cwd = that repo's clone, so the user gets Cockpit's review flow; to answer review comments on your own PR use kind 'address' with prompt '/pr-address <PR number or URL>'. A bare number or URL as the prompt gets the command put in front. Review and address sessions run in cwd itself (worktree is ignored): the user's commands manage their own worktrees.",
        "params": { "prompt": "string", "cwd": "string", "worktree": "boolean", "workspace": "string", "kind": "string" }
    })
}

/// The session that spawned this one, from its first request (None for one you started).
pub fn spawned_by(evs: &[crate::eventlog::Event]) -> Option<String> {
    evs.iter().find(|e| e.kind == "ui.session_requested")?.payload["parent"].as_str().map(str::to_owned)
}

/// Every workspace still there, as (id, name), Personal first.
pub fn workspaces_in(evs: &[crate::eventlog::Event]) -> Vec<(String, String)> {
    let mut out = vec![(crate::workspaces::PERSONAL.to_owned(), "Personal".to_owned())];
    for e in evs {
        let id = e.payload["id"].as_str().unwrap_or_default();
        match e.kind.as_str() {
            "ui.workspace_created" => out.push((id.to_owned(), e.payload["name"].as_str().unwrap_or(id).to_owned())),
            "ui.workspace_renamed" => {
                if let Some(w) = out.iter_mut().find(|w| w.0 == id) {
                    w.1 = e.payload["name"].as_str().unwrap_or(id).to_owned();
                }
            }
            "ui.workspace_deleted" => out.retain(|w| w.0 != id),
            _ => {}
        }
    }
    out
}

/// A workspace by id or name (case-insensitive). Err: the ones there are.
pub fn resolve_workspace(all: &[(String, String)], want: &str) -> Result<String, String> {
    let want = want.trim();
    all.iter()
        .find(|(id, name)| id == want || name.eq_ignore_ascii_case(want))
        .map(|w| w.0.clone())
        .ok_or_else(|| format!("Not started: no workspace '{want}'. There are: {}.", all.iter().map(|(id, n)| format!("{n} ({id})")).collect::<Vec<_>>().join(", ")))
}

pub const KINDS: [&str; 3] = ["blank", "review", "address"];

/// The child's kind, prompt and worktree choice, as the start picker would send them: review and
/// address run their command (`/review`, `/pr-address`) in cwd, with no worktree. Err: what to fix.
pub fn kind_and_prompt(kind: Option<&str>, prompt: &str, worktree: Option<bool>) -> Result<(String, String, Option<bool>), String> {
    let kind = kind.map(str::trim).filter(|k| !k.is_empty()).unwrap_or("blank").to_ascii_lowercase();
    let command = match kind.as_str() {
        "blank" => return Ok((kind, prompt.to_owned(), Some(worktree.unwrap_or(true)))),
        "review" => "/review",
        "address" => "/pr-address",
        _ => return Err(format!("Not started: unknown kind '{kind}'. Use one of: {}.", KINDS.join(", "))),
    };
    let prompt = if prompt.starts_with('/') { prompt.to_owned() } else { format!("{command} {prompt}") };
    Ok((kind, prompt, None))
}

/// `cwd` as given, relative to the parent's folder; the parent's folder when empty.
pub fn resolve_cwd(parent_cwd: &str, want: Option<&str>) -> String {
    match want.map(str::trim).filter(|c| !c.is_empty()) {
        None => parent_cwd.to_owned(),
        Some(c) if c.starts_with('/') || c.starts_with('~') || std::path::Path::new(c).is_absolute() => c.to_owned(),
        Some(c) => std::path::Path::new(parent_cwd).join(c).display().to_string(),
    }
}

/// Starts the child. Ok: the events for the parent's log and the tool's answer. Err: what to fix.
pub fn handle(app: &AppHandle, parent: &str, args: &Value) -> Result<(Vec<(String, Value)>, String), String> {
    let log = app.state::<crate::eventlog::EventLog>();
    let evs = log.list(Some(parent), None, 100_000).unwrap_or_default();
    if spawned_by(&evs).is_some() {
        return Err("Not started: a spawned session can't spawn more sessions. Do the work here, or ask the user to start one.".into());
    }
    let prompt = args["prompt"].as_str().map(str::trim).filter(|p| !p.is_empty()).ok_or("Not started: 'prompt' must be the new session's task.")?;
    let req = evs.iter().find(|e| e.kind == "ui.session_requested").map(|e| e.payload.clone()).unwrap_or_default();
    let parent_cwd = req["worktree"].as_str().or(req["cwd"].as_str()).unwrap_or_default();
    let cwd = resolve_cwd(parent_cwd, args["cwd"].as_str());
    let workspace = match args["workspace"].as_str().filter(|w| !w.trim().is_empty()) {
        Some(w) => resolve_workspace(&workspaces_in(&log.list_prefixed(&["ui.workspace_"]).unwrap_or_default()), w)?,
        None => crate::workspaces::workspace_in(&evs),
    };
    let (kind, prompt, worktree) = kind_and_prompt(args["kind"].as_str(), prompt, args["worktree"].as_bool())?;
    let started = crate::sidecar::Started { parent: Some(parent.to_owned()), ..Default::default() };
    let child = crate::sidecar::start_with(app.clone(), app.state::<crate::sidecar::Sidecar>(), cwd.clone(), prompt.clone(), None, None, Some(kind.clone()), worktree, None, Some(workspace.clone()), None, None, started)
        .map_err(|e| format!("Not started: {e}"))?;
    let child_evs = log.list(Some(&child), None, 50).unwrap_or_default();
    let at = child_evs.iter().find(|e| e.kind == "ui.session_requested").map(|e| e.payload.clone()).unwrap_or_default();
    let dir = at["worktree"].as_str().unwrap_or(&cwd).to_owned();
    let branch = at["branch"].as_str().map(|b| format!(" on branch {b}")).unwrap_or_default();
    let ev = json!({ "child": child, "prompt": prompt, "cwd": dir, "workspace": workspace, "worktree": worktree.unwrap_or(false), "kind": kind });
    Ok((vec![("session.spawned".into(), ev)], format!("Started {kind} session {child} in {dir}{branch} (workspace {workspace}). It runs on its own and shows on the user's Wall; its replies come back to you as messages when it finishes a turn.")))
}

pub fn remember(child: &str, parent: &str, prompt: &str) {
    PARENTS.lock().unwrap().insert(child.to_owned(), (parent.to_owned(), prompt.to_owned()));
}

/// The message a finished child turn sends its parent; None when there's nothing to say.
pub fn report_text(child: &str, name: &str, message: &Value) -> Option<String> {
    let result = message["result"].as_str().map(str::trim).unwrap_or_default();
    let failed = message["is_error"] == true;
    if result.is_empty() && !failed {
        return None;
    }
    let mut body: String = result.chars().take(REPORT_MAX).collect();
    if result.chars().count() > REPORT_MAX {
        body.push_str("\n[…cut; the rest is in that session]");
    }
    let name: String = name.lines().next().unwrap_or_default().chars().take(60).collect();
    let how = if failed { "stopped with an error" } else { "finished a turn" };
    Some(format!("[Report from spawned session \"{name}\" ({child}), which {how}]\n{}", if body.is_empty() { "(no reply text)".into() } else { body }))
}

/// A child's turn ended: tell its parent now if it's running, else keep it for your next message.
pub fn on_turn_end(app: &AppHandle, child: &str, message: &Value) {
    let Some((parent, prompt)) = PARENTS.lock().unwrap().get(child).cloned() else { return };
    let log = app.state::<crate::eventlog::EventLog>();
    let title = log.list_kind("session.titled").unwrap_or_default().into_iter().rev().find(|e| e.session_id.as_deref() == Some(child)).and_then(|e| e.payload["title"].as_str().map(str::to_owned));
    let Some(text) = report_text(child, title.as_deref().unwrap_or(&prompt), message) else { return };
    if !crate::sidecar::is_live(app, &parent) {
        crate::eventlog::record(app, Some(&parent), "session.child_report_waiting", &json!({ "child": child, "text": text }), None);
        return;
    }
    crate::eventlog::record(app, Some(&parent), "session.child_report", &json!({ "child": child, "text": text }), None);
    let _ = crate::sidecar::send_to_live(app, &parent, &text);
}

/// Reports still waiting for `parent`, as ((waiting event id, child), text), oldest first.
pub fn waiting_for(app: &AppHandle, parent: &str) -> Vec<((String, String), String)> {
    let log = app.state::<crate::eventlog::EventLog>();
    let waiting = log.list_kind("session.child_report_waiting").unwrap_or_default();
    let sent = log.list_kind("session.child_report").unwrap_or_default();
    pending(&waiting, &sent, parent)
}

pub fn pending(waiting: &[crate::eventlog::Event], sent: &[crate::eventlog::Event], parent: &str) -> Vec<((String, String), String)> {
    waiting
        .iter()
        .filter(|w| w.session_id.as_deref() == Some(parent) && !sent.iter().any(|s| s.payload["waited"].as_str() == Some(&w.id)))
        .map(|w| ((w.id.clone(), w.payload["child"].as_str().unwrap_or_default().to_owned()), w.payload["text"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eventlog::Event;

    fn ev(kind: &str, payload: Value) -> Event {
        Event { id: String::new(), session_id: None, kind: kind.into(), payload, anchor: None, created_at: 0, origin: None }
    }

    #[test]
    fn only_a_session_requested_with_a_parent_is_spawned() {
        assert_eq!(spawned_by(&[ev("ui.session_requested", json!({ "cwd": "/x" }))]), None);
        assert_eq!(spawned_by(&[ev("ui.session_requested", json!({ "parent": "P" })), ev("ui.session_requested", json!({ "resume": "s" }))]).as_deref(), Some("P"));
        assert_eq!(spawned_by(&[]), None);
    }

    #[test]
    fn workspaces_resolve_by_id_or_name_and_deleted_ones_are_gone() {
        let all = workspaces_in(&[
            ev("ui.workspace_created", json!({ "id": "ws_a", "name": "Work" })),
            ev("ui.workspace_created", json!({ "id": "ws_b", "name": "Side" })),
            ev("ui.workspace_renamed", json!({ "id": "ws_a", "name": "Client" })),
            ev("ui.workspace_deleted", json!({ "id": "ws_b" })),
        ]);
        assert_eq!(resolve_workspace(&all, "client").unwrap(), "ws_a");
        assert_eq!(resolve_workspace(&all, "ws_a").unwrap(), "ws_a");
        assert_eq!(resolve_workspace(&all, "Personal").unwrap(), "personal");
        let err = resolve_workspace(&all, "Side").unwrap_err();
        assert!(err.contains("Personal (personal)") && err.contains("Client (ws_a)") && !err.contains("ws_b"), "{err}");
    }

    #[test]
    fn a_child_reports_its_reply_or_its_error_and_long_ones_are_cut() {
        let ok = report_text("C", "Write the changelog", &json!({ "result": " Done: 5 entries. ", "is_error": false })).unwrap();
        assert_eq!(ok, "[Report from spawned session \"Write the changelog\" (C), which finished a turn]\nDone: 5 entries.");
        assert!(report_text("C", "x", &json!({ "result": "" })).is_none());
        assert!(report_text("C", "x", &json!({ "is_error": true })).unwrap().contains("stopped with an error]\n(no reply text)"));
        let long = report_text("C", "x", &json!({ "result": "a".repeat(REPORT_MAX + 10) })).unwrap();
        assert!(long.ends_with("[…cut; the rest is in that session]") && long.matches('a').count() >= REPORT_MAX);
    }

    #[test]
    fn waiting_reports_go_once_and_only_to_their_parent() {
        let at = |id: &str, sid: &str, kind: &str, p: Value| Event { id: id.into(), session_id: Some(sid.into()), kind: kind.into(), payload: p, anchor: None, created_at: 0, origin: None };
        let waiting = [at("W1", "P", "session.child_report_waiting", json!({ "child": "C", "text": "one" })), at("W2", "P", "session.child_report_waiting", json!({ "child": "C", "text": "two" })), at("W3", "Q", "session.child_report_waiting", json!({ "child": "D", "text": "other" }))];
        let sent = [at("S1", "P", "session.child_report", json!({ "waited": "W1" }))];
        assert_eq!(pending(&waiting, &sent, "P"), vec![(("W2".into(), "C".into()), "two".into())]);
        assert_eq!(pending(&waiting, &[], "Q").len(), 1);
    }

    #[test]
    fn kind_defaults_to_blank_and_review_or_address_start_like_the_picker() {
        assert_eq!(kind_and_prompt(None, "Write docs", None).unwrap(), ("blank".into(), "Write docs".into(), Some(true)));
        assert_eq!(kind_and_prompt(Some(" "), "x", Some(false)).unwrap(), ("blank".into(), "x".into(), Some(false)));
        assert_eq!(kind_and_prompt(Some("review"), "/review 58", Some(true)).unwrap(), ("review".into(), "/review 58".into(), None));
        assert_eq!(kind_and_prompt(Some("Review"), "https://github.com/a/b/pull/4", None).unwrap(), ("review".into(), "/review https://github.com/a/b/pull/4".into(), None));
        assert_eq!(kind_and_prompt(Some("address"), "62", None).unwrap(), ("address".into(), "/pr-address 62".into(), None));
        let err = kind_and_prompt(Some("plan"), "x", None).unwrap_err();
        assert!(err.contains("unknown kind 'plan'") && err.contains("blank, review, address"), "{err}");
    }

    #[test]
    fn cwd_defaults_to_the_parents_and_relative_paths_are_from_it() {
        assert_eq!(resolve_cwd("/repo", None), "/repo");
        assert_eq!(resolve_cwd("/repo", Some(" ")), "/repo");
        assert_eq!(resolve_cwd("/repo", Some("/other")), "/other");
        assert_eq!(resolve_cwd("/repo", Some("~/code")), "~/code");
        assert_eq!(resolve_cwd("/repo", Some("ui")), std::path::Path::new("/repo").join("ui").display().to_string());
    }
}
