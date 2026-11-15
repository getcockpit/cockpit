//! The Face ID gate (doc "Cockpit Remote", security block): approving a permission, answering a
//! question or starting a session runs Claude on the Mac, so each needs a fresh Face ID (or the
//! passcode) on the phone before the command leaves it. Denying, replying and stopping don't:
//! opening the link already needed Face ID (key.rs). The check lives here, in the core, so no UI
//! path can send a gated command without it.

use remote_link::proto::Command;

/// Why this command needs Face ID, as the system prompt shows it; None when it doesn't.
pub fn reason(c: &Command) -> Option<&'static str> {
    match c {
        Command::PermissionResponse { decision, .. } if decision["behavior"] == "allow" => Some("Allow this on your Mac"),
        Command::AnswerQuestion { .. } => Some("Answer Claude on your Mac"),
        Command::StartSession { .. } => Some("Start a session on your Mac"),
        _ => None,
    }
}

/// Asks for Face ID (passcode as fallback). Err when it's cancelled or fails.
#[cfg(target_os = "ios")]
pub async fn check(app: &tauri::AppHandle, why: &'static str) -> Result<(), String> {
    use tauri_plugin_biometric::{AuthOptions, BiometricExt};
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        app.biometric()
            .authenticate(why.into(), AuthOptions { allow_device_credential: true, cancel_title: Some("Cancel".into()), ..Default::default() })
            .map_err(|e| format!("Face ID didn't confirm it ({e}); nothing was sent"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The desktop build of this app (development only) has no Face ID to ask.
#[cfg(not(target_os = "ios"))]
pub async fn check(_app: &tauri::AppHandle, why: &'static str) -> Result<(), String> {
    eprintln!("[remote] no Face ID on this platform; would ask: {why}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_commands_that_run_claude_need_face_id() {
        let allow = Command::PermissionResponse { session: "s".into(), request_id: "r".into(), decision: json!({ "behavior": "allow" }) };
        let deny = Command::PermissionResponse { session: "s".into(), request_id: "r".into(), decision: json!({ "behavior": "deny", "message": "no" }) };
        assert!(reason(&allow).is_some());
        assert!(reason(&deny).is_none());
        assert!(reason(&Command::AnswerQuestion { session: "s".into(), request_id: "r".into(), input: json!({}), answers: [("q".to_string(), "a".to_string())].into() }).is_some());
        assert!(reason(&Command::StartSession { workspace_id: "w".into(), repo_id: "r".into(), prompt: "p".into(), kind: None }).is_some());
        assert!(reason(&Command::SendPrompt { session: "s".into(), text: "hi".into() }).is_none());
        assert!(reason(&Command::StopSession { session: "s".into() }).is_none());
        assert!(reason(&Command::Interrupt { session: "s".into() }).is_none());
    }
}
