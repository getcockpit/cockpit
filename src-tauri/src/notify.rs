//! macOS notifications for decisions that need you (MR-94). The UI decides what to say (it owns the
//! needs-you queue); this module shows it and reports back what you did with it: a click opens the
//! app on that decision (deep link), an action button or a typed reply answers it in place.
//! Notifications go through `NSUserNotificationCenter` (mac-notification-sys), the only macOS API
//! that reports clicks, actions and replies to an unsigned app run as a bare dev binary.

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize)]
pub struct Note {
    /// The needs-you queue key (`ask:<id>`, `prose:<id>`, `doc:<doc>:<block>`…); comes back as-is.
    pub key: String,
    pub session: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub body: String,
    /// Up to four quick answers, shown under the notification's Answer button.
    #[serde(default)]
    pub actions: Vec<String>,
    /// A text field instead of actions: the reply is sent to the session.
    #[serde(default)]
    pub reply: bool,
}

/// What you did with a notification, sent to the UI on `mr-notify`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Response {
    Open,
    Action { value: String },
    Reply { value: String },
    Dismissed,
}

/// The dropdown is passed to macOS as one comma-joined string, so a comma would split a choice.
pub fn clean_actions(actions: &[String]) -> Vec<String> {
    actions
        .iter()
        .map(|a| a.replace(',', " ").split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|a| !a.is_empty())
        .take(4)
        .collect()
}

#[tauri::command]
pub fn notify(app: AppHandle, note: Note) -> Result<(), String> {
    crate::eventlog::record(&app, note.session.as_deref(), "notify.sent", &json!({ "key": note.key, "title": note.title, "body": note.body }), None);
    if std::env::var("MR_SELFTEST").is_ok() {
        return Ok(()); // self-tests check the log, not the screen
    }
    // A notification waits for its click on its own thread, so many can be out at once.
    std::thread::spawn(move || {
        let response = show(&note);
        let done = !matches!(response, Response::Dismissed);
        // The UI acts on it: a click brings the app forward on the decision, an answer is sent without it.
        if done {
            crate::eventlog::record(&app, note.session.as_deref(), "ui.notify_response", &json!({ "key": note.key, "response": response }), None);
            let _ = app.emit("mr-notify", json!({ "key": note.key, "session": note.session, "response": response }));
        }
    });
    Ok(())
}

/// macOS shows no banner for the frontmost app unless the center's delegate answers YES to
/// `userNotificationCenter:shouldPresentNotification:`, and mac-notification-sys's delegate doesn't
/// implement it. The installed Cockpit.app is the frontmost app whenever you press Send a test, so
/// the test landed in Notification Center silently (a dev binary escaped this: its borrowed bundle
/// id isn't the frontmost app's). Adds the method to that class before its delegate is first set.
#[cfg(target_os = "macos")]
fn present_while_frontmost() {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn class_addMethod(cls: *mut c_void, sel: *const c_void, imp: *const c_void, types: *const c_char) -> bool;
    }
    extern "C" fn should_present(_this: *mut c_void, _cmd: *const c_void, _center: *mut c_void, _note: *mut c_void) -> bool {
        true
    }
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let cls = objc_getClass(c"NotificationCenterDelegate".as_ptr());
        if cls.is_null() {
            eprintln!("[notify] no NotificationCenterDelegate class; banners only while Cockpit is in the background");
            return;
        }
        let sel = sel_registerName(c"userNotificationCenter:shouldPresentNotification:".as_ptr());
        class_addMethod(cls, sel, should_present as *const c_void, c"c@:@@".as_ptr());
    });
}

#[cfg(target_os = "macos")]
fn show(note: &Note) -> Response {
    use mac_notification_sys::{set_application, MainButton, Notification, NotificationResponse};
    present_while_frontmost();
    // A dev build is a bare binary with no bundle id; borrow the installed app's so macOS shows it
    // under Cockpit. Errors only mean it was already set (or no Cockpit.app is registered).
    let _ = set_application("dev.minorityreport.app");
    let actions = clean_actions(&note.actions);
    let refs: Vec<&str> = actions.iter().map(String::as_str).collect();
    let mut n = Notification::new();
    n.title(&note.title).subtitle(&note.subtitle).message(&note.body).default_sound().wait_for_click(true);
    if note.reply {
        n.main_button(MainButton::Response("Reply…"));
    } else if !refs.is_empty() {
        n.main_button(MainButton::DropdownActions("Answer", &refs));
    }
    match n.send() {
        Ok(NotificationResponse::Click) => Response::Open,
        Ok(NotificationResponse::ActionButton(v)) if refs.contains(&v.as_str()) => Response::Action { value: v },
        Ok(NotificationResponse::ActionButton(_)) => Response::Open, // the Answer button itself
        Ok(NotificationResponse::Reply(v)) if !v.trim().is_empty() => Response::Reply { value: v.trim().to_owned() },
        Ok(_) => Response::Dismissed,
        Err(e) => {
            eprintln!("[notify] {e}");
            Response::Dismissed
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn show(_: &Note) -> Response {
    Response::Dismissed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_survive_the_comma_joined_dropdown() {
        let got = clean_actions(&["Allow".into(), "Yes, go ahead".into(), "  ".into(), "c".into(), "d".into(), "e".into()]);
        assert_eq!(got, vec!["Allow", "Yes go ahead", "c", "d"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_delegate_asks_for_a_banner_while_frontmost() {
        use std::ffi::{c_char, c_void};
        #[link(name = "objc")]
        unsafe extern "C" {
            fn objc_getClass(name: *const c_char) -> *mut c_void;
            fn sel_registerName(name: *const c_char) -> *const c_void;
            fn class_respondsToSelector(cls: *mut c_void, sel: *const c_void) -> bool;
        }
        present_while_frontmost();
        unsafe {
            let cls = objc_getClass(c"NotificationCenterDelegate".as_ptr());
            assert!(!cls.is_null(), "mac-notification-sys renamed its delegate class");
            assert!(class_respondsToSelector(cls, sel_registerName(c"userNotificationCenter:shouldPresentNotification:".as_ptr())));
        }
    }

    #[test]
    fn responses_serialize_for_the_ui() {
        assert_eq!(serde_json::to_value(Response::Open).unwrap(), json!({ "kind": "open" }));
        assert_eq!(serde_json::to_value(Response::Action { value: "Allow".into() }).unwrap(), json!({ "kind": "action", "value": "Allow" }));
    }
}
