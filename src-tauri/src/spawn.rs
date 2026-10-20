//! `session_spawn` (MR-176): a session starts another Cockpit session, with no approval. The parent
//! picks the folder, the workspace and whether the child gets its own worktree. One level only: a
//! spawned session isn't offered the tool, and a call from one is refused. The session cap applies.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const TOOL: &str = "session_spawn";

pub fn tool_spec() -> Value {
    json!({
        "name": TOOL,
        "description": "Start another Cockpit session that works on its own, in parallel, and shows on the user's Wall (no approval needed). Use it for independent work that deserves its own thread, not for quick lookups (use subagents for those). prompt: the full task, self-contained; the new session doesn't see this conversation. cwd: the folder it works in (default: yours; relative paths are from yours). worktree: true (default) gives it its own git worktree and branch off cwd's repo, false runs it in cwd as is, sharing the checkout. workspace: a workspace id or name (default: yours; 'personal' is the default workspace); an unknown one returns the list. Returns the new session's id. Spawned sessions can't spawn more. The session cap still applies.",
        "params": { "prompt": "string", "cwd": "string", "worktree": "boolean", "workspace": "string" }
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
    let worktree = args["worktree"].as_bool().unwrap_or(true);
    let started = crate::sidecar::Started { parent: Some(parent.to_owned()), ..Default::default() };
    let child = crate::sidecar::start_with(app.clone(), app.state::<crate::sidecar::Sidecar>(), cwd.clone(), prompt.to_owned(), None, None, Some("blank".into()), Some(worktree), None, Some(workspace.clone()), None, None, started)
        .map_err(|e| format!("Not started: {e}"))?;
    let child_evs = log.list(Some(&child), None, 50).unwrap_or_default();
    let at = child_evs.iter().find(|e| e.kind == "ui.session_requested").map(|e| e.payload.clone()).unwrap_or_default();
    let dir = at["worktree"].as_str().unwrap_or(&cwd).to_owned();
    let branch = at["branch"].as_str().map(|b| format!(" on branch {b}")).unwrap_or_default();
    let ev = json!({ "child": child, "prompt": prompt, "cwd": dir, "workspace": workspace, "worktree": worktree });
    Ok((vec![("session.spawned".into(), ev)], format!("Started session {child} in {dir}{branch} (workspace {workspace}). It runs on its own and shows on the user's Wall; you won't get its results back here.")))
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
    fn cwd_defaults_to_the_parents_and_relative_paths_are_from_it() {
        assert_eq!(resolve_cwd("/repo", None), "/repo");
        assert_eq!(resolve_cwd("/repo", Some(" ")), "/repo");
        assert_eq!(resolve_cwd("/repo", Some("/other")), "/other");
        assert_eq!(resolve_cwd("/repo", Some("~/code")), "~/code");
        assert_eq!(resolve_cwd("/repo", Some("ui")), std::path::Path::new("/repo").join("ui").display().to_string());
    }
}
