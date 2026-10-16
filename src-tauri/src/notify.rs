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

/// How many notifications wait for their click at once. Each waiter costs a thread and a main-thread
/// poll of every delivered notification twice a second (mac-notification-sys's auto-dismiss check),
/// so 68 ignored ones held Cockpit at 55% CPU. Older ones are reposted as plain notifications.
const MAX_WAITING: usize = 3;
/// Plain (demoted) notifications remembered so they can still be taken down once answered.
const MAX_KEPT: usize = 50;

/// What macOS shows, which is how a notification is found again: mac-notification-sys keeps its id.
#[derive(Debug, Clone, PartialEq)]
pub struct Text {
    pub title: String,
    pub subtitle: String,
    pub body: String,
}

#[derive(Debug)]
struct Out {
    id: u64,
    key: String,
    text: Text,
    /// A thread waits for its click; false once demoted to a plain notification.
    waiting: bool,
}

/// The notifications that are up, oldest first.
#[derive(Debug, Default)]
struct Outbox {
    next: u64,
    out: Vec<Out>,
}

/// What `Outbox::add` asks for: take these down, and repost these as plain notifications.
#[derive(Debug, Default, PartialEq)]
struct Changes {
    withdraw: Vec<Text>,
    demote: Vec<Text>,
}

impl Outbox {
    /// A new notification: it replaces the same decision's earlier one, and pushes the oldest
    /// waiter past `MAX_WAITING` down to a plain notification.
    fn add(&mut self, key: &str, text: Text) -> (u64, Changes) {
        let mut ch = Changes::default();
        self.out.retain(|o| o.key != key || {
            ch.withdraw.push(o.text.clone());
            false
        });
        self.next += 1;
        self.out.push(Out { id: self.next, key: key.to_owned(), text, waiting: true });
        while self.out.iter().filter(|o| o.waiting).count() > MAX_WAITING {
            let o = self.out.iter_mut().find(|o| o.waiting).expect("over the cap");
            o.waiting = false;
            ch.demote.push(o.text.clone());
        }
        while self.out.len() > MAX_KEPT {
            let Some(i) = self.out.iter().position(|o| !o.waiting) else { break };
            self.out.remove(i);
        }
        (self.next, ch)
    }

    /// Its waiter returned. A demoted one stays: its plain copy is still up.
    fn done(&mut self, id: u64) {
        self.out.retain(|o| o.id != id || !o.waiting);
    }

    /// These decisions were answered or went away: their notifications come down.
    fn resolve(&mut self, keys: &[String]) -> Vec<Text> {
        let mut gone = Vec::new();
        self.out.retain(|o| !keys.contains(&o.key) || {
            gone.push(o.text.clone());
            false
        });
        gone
    }
}

static OUTBOX: std::sync::Mutex<Outbox> = std::sync::Mutex::new(Outbox { next: 0, out: Vec::new() });

fn outbox() -> std::sync::MutexGuard<'static, Outbox> {
    OUTBOX.lock().unwrap_or_else(|e| e.into_inner())
}

/// Takes notifications down, then reposts the demoted ones silently without waiting. Removing a
/// waiter's notification ends its thread (its poll sees it gone and reports Dismissed).
fn apply(app: &AppHandle, ch: Changes) {
    if ch.withdraw.is_empty() && ch.demote.is_empty() {
        return;
    }
    let _ = app.run_on_main_thread(move || {
        take_down(ch.withdraw.iter().chain(&ch.demote));
        if !ch.demote.is_empty() {
            std::thread::spawn(move || ch.demote.iter().for_each(post_plain));
        }
    });
}

/// The UI's needs-you queue dropped these keys (answered in the app, or the session moved on).
#[tauri::command]
pub fn notify_withdraw(app: AppHandle, keys: Vec<String>) {
    let withdraw = outbox().resolve(&keys);
    apply(&app, Changes { withdraw, demote: vec![] });
}

#[tauri::command]
pub fn notify(app: AppHandle, note: Note) -> Result<(), String> {
    crate::eventlog::record(&app, note.session.as_deref(), "notify.sent", &json!({ "key": note.key, "title": note.title, "body": note.body }), None);
    if std::env::var("MR_SELFTEST").is_ok() {
        return Ok(()); // self-tests check the log, not the screen
    }
    let text = Text { title: note.title.clone(), subtitle: note.subtitle.clone(), body: note.body.clone() };
    let (id, ch) = outbox().add(&note.key, text);
    apply(&app, ch);
    // A notification waits for its click on its own thread; the outbox keeps how many at once bounded.
    std::thread::spawn(move || {
        let response = show(&note);
        outbox().done(id);
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
    let _ = set_application(crate::migrate::ID);
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

/// A demoted notification, shown again without a sound or a waiter: a click just opens Cockpit.
#[cfg(target_os = "macos")]
fn post_plain(t: &Text) {
    let mut n = mac_notification_sys::Notification::new();
    n.title(&t.title).subtitle(&t.subtitle).message(&t.body).wait_for_click(false);
    if let Err(e) = n.send() {
        eprintln!("[notify] {e}");
    }
}

/// Removes the delivered notifications showing these texts. Main thread only.
#[cfg(target_os = "macos")]
fn take_down<'a>(texts: impl Iterator<Item = &'a Text>) {
    use std::ffi::{c_char, c_void, CStr};
    type Id = *mut c_void;
    type Sel = *const c_void;
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }
    let texts: Vec<&Text> = texts.collect();
    if texts.is_empty() {
        return;
    }
    unsafe {
        let send0: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let count: unsafe extern "C" fn(Id, Sel) -> usize = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let at: unsafe extern "C" fn(Id, Sel, usize) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let remove: unsafe extern "C" fn(Id, Sel, Id) = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let sel = |s: &CStr| sel_registerName(s.as_ptr());
        let string = |obj: Id, prop: &CStr| -> String {
            let s = send0(obj, sel(prop));
            if s.is_null() {
                return String::new();
            }
            let p = send0(s, sel(c"UTF8String")) as *const c_char;
            if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
        };
        let pool = objc_autoreleasePoolPush();
        let center = send0(objc_getClass(c"NSUserNotificationCenter".as_ptr()), sel(c"defaultUserNotificationCenter"));
        if !center.is_null() {
            let delivered = send0(center, sel(c"deliveredNotifications"));
            let n = if delivered.is_null() { 0 } else { count(delivered, sel(c"count")) };
            for i in 0..n {
                let note = at(delivered, sel(c"objectAtIndex:"), i);
                let shown = Text { title: string(note, c"title"), subtitle: string(note, c"subtitle"), body: string(note, c"informativeText") };
                if texts.contains(&&shown) {
                    remove(center, sel(c"removeDeliveredNotification:"), note);
                }
            }
        }
        objc_autoreleasePoolPop(pool);
    }
}

#[cfg(not(target_os = "macos"))]
fn show(_: &Note) -> Response {
    Response::Dismissed
}

#[cfg(not(target_os = "macos"))]
fn post_plain(_: &Text) {}

#[cfg(not(target_os = "macos"))]
fn take_down<'a>(_: impl Iterator<Item = &'a Text>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> Text {
        Text { title: s.into(), subtitle: String::new(), body: String::new() }
    }

    #[test]
    fn only_the_newest_few_wait_and_the_rest_are_demoted() {
        let mut b = Outbox::default();
        for k in ["a", "b", "c"] {
            assert_eq!(b.add(k, t(k)).1, Changes::default());
        }
        let (_, ch) = b.add("d", t("d"));
        assert_eq!(ch, Changes { withdraw: vec![], demote: vec![t("a")] });
        assert_eq!(b.out.iter().filter(|o| o.waiting).count(), MAX_WAITING);
        // A demoted note's waiter returning keeps it: its plain copy is still up and can be answered away.
        b.done(1);
        assert_eq!(b.resolve(&["a".into()]), vec![t("a")]);
    }

    #[test]
    fn the_same_decision_replaces_its_note_and_answering_takes_it_down() {
        let mut b = Outbox::default();
        let (first, _) = b.add("ask:1", t("old"));
        let (_, ch) = b.add("ask:1", t("new"));
        assert_eq!(ch.withdraw, vec![t("old")]);
        b.done(first); // the replaced waiter ends; the new one stays
        assert_eq!(b.resolve(&["ask:1".into()]), vec![t("new")]);
        assert!(b.out.is_empty());
    }

    #[test]
    fn a_finished_waiter_is_forgotten_and_old_plain_notes_are_capped() {
        let mut b = Outbox::default();
        let (id, _) = b.add("x", t("x"));
        b.done(id);
        assert!(b.out.is_empty());
        for i in 0..(MAX_KEPT + 10) {
            b.add(&i.to_string(), t("n"));
        }
        assert_eq!(b.out.len(), MAX_KEPT);
        assert_eq!(b.out.iter().filter(|o| o.waiting).count(), MAX_WAITING);
    }

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

#[cfg(all(test, target_os = "macos"))]
mod live {
    use super::*;

    /// Posts a silent notification and takes it down by its text. Shows a banner, so it's opt-in:
    /// `cargo test notify::live -- --ignored`.
    #[test]
    #[ignore]
    fn a_posted_note_is_found_and_taken_down() {
        let _ = mac_notification_sys::set_application(crate::migrate::ID);
        let text = Text { title: "Cockpit take-down check".into(), subtitle: "notify::live".into(), body: format!("{:?}", std::time::SystemTime::now()) };
        post_plain(&text);
        let shown = || unsafe { delivered_count_with(&text) };
        assert_eq!(shown(), 1, "the plain note wasn't delivered");
        take_down(std::iter::once(&text));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(shown(), 0, "take_down left it up");
    }

    unsafe fn delivered_count_with(t: &Text) -> usize {
        use std::ffi::{c_char, c_void, CStr};
        type Id = *mut c_void;
        #[link(name = "objc")]
        unsafe extern "C" {
            fn objc_getClass(name: *const c_char) -> Id;
            fn sel_registerName(name: *const c_char) -> *const c_void;
            fn objc_msgSend();
        }
        unsafe {
            let send0: unsafe extern "C" fn(Id, *const c_void) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let count: unsafe extern "C" fn(Id, *const c_void) -> usize = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let at: unsafe extern "C" fn(Id, *const c_void, usize) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let sel = |s: &CStr| sel_registerName(s.as_ptr());
            let center = send0(objc_getClass(c"NSUserNotificationCenter".as_ptr()), sel(c"defaultUserNotificationCenter"));
            let all = send0(center, sel(c"deliveredNotifications"));
            (0..count(all, sel(c"count")))
                .filter(|&i| {
                    let body = send0(send0(at(all, sel(c"objectAtIndex:"), i), sel(c"informativeText")), sel(c"UTF8String")) as *const c_char;
                    !body.is_null() && CStr::from_ptr(body).to_str() == Ok(t.body.as_str())
                })
                .count()
        }
    }
}
