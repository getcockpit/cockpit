//! macOS notifications for decisions that need you (MR-94). The UI decides what to say (it owns the
//! needs-you queue); this module shows it and reports back what you did with it: a click opens the
//! app on that decision (deep link), an action button or a typed reply answers it in place.
//! Notifications go through `UNUserNotificationCenter`, which needs Cockpit.app signed with a real
//! Apple certificate: macOS 26 refuses an ad-hoc-signed app, and a bare dev binary has no bundle.

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
    /// Up to four quick answers, shown as the notification's action buttons.
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
}

/// What a notification carries in its `userInfo`, so a click after a restart still knows its decision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Info {
    key: String,
    session: Option<String>,
    actions: Vec<String>,
}

/// The labels shown as buttons: non-blank, at most four, sent back exactly as given.
fn actions_of(note: &Note) -> Vec<String> {
    note.actions.iter().filter(|a| !a.trim().is_empty()).take(4).cloned().collect()
}

/// Maps the button macOS reports (`a<i>`, `reply`, or the body click) back to a response.
fn response_for(action: &str, default: bool, labels: &[String], text: Option<String>) -> Option<Response> {
    if default {
        return Some(Response::Open);
    }
    if action == "reply" {
        let v = text.unwrap_or_default().trim().to_owned();
        return Some(if v.is_empty() { Response::Open } else { Response::Reply { value: v } });
    }
    let i: usize = action.strip_prefix('a')?.parse().ok()?;
    labels.get(i).map(|v| Response::Action { value: v.clone() })
}

/// One category per distinct action set, so notifications with the same answers share it.
fn category_id(labels: &[String]) -> String {
    // FNV-1a: stable across runs, so notifications left from an earlier run keep their buttons.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in labels.join("\u{1f}").bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("act-{h:016x}")
}

/// Records what you did and hands it to the UI, which opens or answers the decision.
fn respond(app: &AppHandle, info: &Info, response: Response) {
    crate::eventlog::record(app, info.session.as_deref(), "ui.notify_response", &json!({ "key": info.key, "response": response }), None);
    let _ = app.emit("mr-notify", json!({ "key": info.key, "session": info.session, "response": response }));
}

#[tauri::command]
pub async fn notify(app: AppHandle, note: Note) -> Result<(), String> {
    crate::eventlog::record(&app, note.session.as_deref(), "notify.sent", &json!({ "key": note.key, "title": note.title, "body": note.body }), None);
    if std::env::var("MR_SELFTEST").is_ok() {
        return Ok(()); // self-tests check the log, not the screen
    }
    // Waits on macOS (authorization, then delivery) off the main thread so errors reach the caller.
    tauri::async_runtime::spawn_blocking(move || mac::post(&note)).await.map_err(|e| e.to_string())?
}

/// Installs the delegate that hears clicks, actions and replies, before any can arrive.
pub fn init(app: &AppHandle) {
    mac::init(app);
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{actions_of, category_id, respond, response_for, Info, Note};
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSSet, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction, UNNotificationActionOptions,
        UNNotificationCategory, UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNTextInputNotificationAction, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::Duration;
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static AUTHORIZED: AtomicBool = AtomicBool::new(false);
    /// Every category registered so far (id → action labels; `reply` has none). macOS replaces the
    /// whole set on each update, so it's resent in full.
    static CATEGORIES: Mutex<BTreeMap<String, Vec<String>>> = Mutex::new(BTreeMap::new());

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "CockpitNotifyDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _center: &UNUserNotificationCenter, _note: &UNNotification, done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                // The UI only posts while Cockpit is in the background; show it even if it just came forward.
                done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
                received(response);
                done.call(());
            }
        }
    );

    fn received(response: &UNNotificationResponse) {
        let Some(app) = APP.get() else { return };
        let user_info = response.notification().request().content().userInfo();
        let Some(info) = user_info
            .objectForKey(&**NSString::from_str("mr"))
            .and_then(|o| o.downcast::<NSString>().ok())
            .and_then(|s| serde_json::from_str::<Info>(&s.to_string()).ok())
        else {
            return;
        };
        let action = response.actionIdentifier();
        let default = &*action == unsafe { UNNotificationDefaultActionIdentifier };
        let text = response.downcast_ref::<objc2_user_notifications::UNTextInputNotificationResponse>().map(|r| r.userText().to_string());
        // Dismissals (and anything unknown) aren't reported.
        if let Some(r) = response_for(&action.to_string(), default, &info.actions, text) {
            respond(app, &info, r);
        }
    }

    /// `UNUserNotificationCenter` throws without an app bundle, so a bare dev binary is turned away first.
    fn bundled() -> bool {
        let main = NSBundle::mainBundle();
        main.bundleIdentifier().is_some() && main.bundlePath().to_string().ends_with(".app")
    }

    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        if !bundled() {
            return;
        }
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly; this one lives as long as the app.
        std::mem::forget(delegate);
    }

    #[cfg(test)]
    #[test]
    fn the_delegate_answers_both_callbacks() {
        use objc2::{sel, ClassType, ProtocolType};
        let d: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        assert!(Delegate::class().conforms_to(<dyn UNUserNotificationCenterDelegate>::protocol().unwrap()));
        assert!(d.respondsToSelector(sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:)));
        assert!(d.respondsToSelector(sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:)));
    }

    /// Runs `start`, then waits for the completion handler it was given to report.
    fn wait<T: 'static>(what: &str, start: impl FnOnce(mpsc::Sender<T>)) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        start(tx);
        rx.recv_timeout(Duration::from_secs(10)).map_err(|_| format!("macOS didn't answer the {what} within 10 s"))
    }

    fn describe(err: *mut NSError) -> Option<String> {
        unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string())
    }

    fn authorize(center: &UNUserNotificationCenter) -> Result<(), String> {
        if AUTHORIZED.load(Ordering::Relaxed) {
            return Ok(());
        }
        // A denial isn't cached: once you allow Cockpit in System Settings, the next one goes through.
        let (granted, err) = wait("notification permission request", |tx| {
            let block = RcBlock::new(move |granted: Bool, err: *mut NSError| {
                let _ = tx.send((granted.as_bool(), describe(err)));
            });
            center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
        })?;
        if !granted || err.is_some() {
            let reason = err.unwrap_or_else(|| "permission is off".into());
            return Err(format!("macOS isn't allowing Cockpit's notifications: {reason}. Allow Cockpit in System Settings → Notifications."));
        }
        AUTHORIZED.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Registers the category for this note's buttons (if new) and returns its id.
    fn category(center: &UNUserNotificationCenter, labels: &[String], reply: bool) -> Option<String> {
        let id = if reply { "reply".to_owned() } else if labels.is_empty() { return None } else { category_id(labels) };
        let mut all = CATEGORIES.lock().unwrap_or_else(|e| e.into_inner());
        if all.contains_key(&id) {
            return Some(id);
        }
        all.insert(id.clone(), if reply { vec![] } else { labels.to_vec() });
        let none = UNNotificationActionOptions::empty();
        let cats: Vec<Retained<UNNotificationCategory>> = all
            .iter()
            .map(|(id, labels)| {
                let actions: Vec<Retained<UNNotificationAction>> = if id == "reply" {
                    let a = UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
                        &NSString::from_str("reply"),
                        &NSString::from_str("Reply"),
                        none,
                        &NSString::from_str("Send"),
                        &NSString::from_str("Reply…"),
                    );
                    vec![Retained::into_super(a)]
                } else {
                    let labels = labels.iter().enumerate();
                    labels.map(|(i, l)| UNNotificationAction::actionWithIdentifier_title_options(&NSString::from_str(&format!("a{i}")), &NSString::from_str(l), none)).collect()
                };
                UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                    &NSString::from_str(id),
                    &NSArray::from_retained_slice(&actions),
                    &NSArray::new(),
                    UNNotificationCategoryOptions::empty(),
                )
            })
            .collect();
        center.setNotificationCategories(&NSSet::from_retained_slice(&cats));
        Some(id)
    }

    pub fn post(note: &Note) -> Result<(), String> {
        if !bundled() {
            return Err("Notifications need Cockpit.app (a dev binary has no bundle)".into());
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        authorize(&center)?;
        let labels = actions_of(note);
        let info = Info { key: note.key.clone(), session: note.session.clone(), actions: labels.clone() };
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&note.title));
        content.setSubtitle(&NSString::from_str(&note.subtitle));
        content.setBody(&NSString::from_str(&note.body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        if let Some(s) = &note.session {
            content.setThreadIdentifier(&NSString::from_str(s)); // grouped per session
        }
        if let Some(id) = category(&center, &labels, note.reply) {
            content.setCategoryIdentifier(&NSString::from_str(&id));
        }
        let json = serde_json::to_string(&info).map_err(|e| e.to_string())?;
        let user_info = NSDictionary::<NSString, NSString>::from_slices(&[&*NSString::from_str("mr")], &[&*NSString::from_str(&json)]);
        // Safety: string keys and values are valid property-list entries.
        unsafe { content.setUserInfo(user_info.cast_unchecked()) };
        // The key is the identifier, so posting the same decision again replaces it.
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&note.key), &content, None);
        let err = wait("notification", |tx| {
            let block = RcBlock::new(move |err: *mut NSError| {
                let _ = tx.send(describe(err));
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
        })?;
        match err {
            Some(e) => Err(format!("macOS didn't show the notification: {e}")),
            None => Ok(()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::Note;
    use tauri::AppHandle;

    pub fn init(_: &AppHandle) {}

    pub fn post(_: &Note) -> Result<(), String> {
        Err("Notifications are macOS-only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(actions: &[&str]) -> Note {
        Note { key: "ask:1".into(), session: Some("s1".into()), title: "t".into(), subtitle: "s".into(), body: "b".into(), actions: actions.iter().map(|a| a.to_string()).collect(), reply: false }
    }

    #[test]
    fn actions_keep_their_labels() {
        assert_eq!(actions_of(&note(&["Allow", "Yes, go ahead", "  ", "c", "d", "e"])), vec!["Allow", "Yes, go ahead", "c", "d"]);
    }

    #[test]
    fn buttons_map_back_to_responses() {
        let labels = vec!["Allow".to_owned(), "Postgres, managed".to_owned()];
        assert_eq!(response_for("whatever", true, &labels, None), Some(Response::Open));
        assert_eq!(response_for("a1", false, &labels, None), Some(Response::Action { value: "Postgres, managed".into() }));
        assert_eq!(response_for("a7", false, &labels, None), None);
        assert_eq!(response_for("reply", false, &[], Some(" ok ".into())), Some(Response::Reply { value: "ok".into() }));
        assert_eq!(response_for("com.apple.UNNotificationDismissActionIdentifier", false, &labels, None), None);
    }

    #[test]
    fn categories_are_stable_per_action_set() {
        let a = category_id(&["Allow".into(), "Deny".into()]);
        assert_eq!(a, category_id(&["Allow".into(), "Deny".into()]));
        assert_ne!(a, category_id(&["Deny".into(), "Allow".into()]));
    }

    #[test]
    fn responses_serialize_for_the_ui() {
        assert_eq!(serde_json::to_value(Response::Open).unwrap(), json!({ "kind": "open" }));
        assert_eq!(serde_json::to_value(Response::Action { value: "Allow".into() }).unwrap(), json!({ "kind": "action", "value": "Allow" }));
    }

    /// The test binary has no bundle, like a dev build: posting must refuse cleanly, not crash.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_bare_binary_is_refused_not_crashed() {
        assert_eq!(mac::post(&note(&["Allow"])), Err("Notifications need Cockpit.app (a dev binary has no bundle)".into()));
    }
}
