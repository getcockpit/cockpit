//! The zero-setup way into browser annotations: Cockpit starts Chrome itself, with its own profile
//! (`<data>/browser-profile`) and the DevTools protocol over a pipe (`--remote-debugging-pipe`, fds
//! 3 and 4). No port, no extension. Its reach is that one profile.
//!
//! The same overlay the extension injects (`lib.js` + `annotator.js`) runs here in an isolated world
//! named "cockpit", behind `launch.js`, a shim that stands in for `chrome.runtime` and talks to the
//! core through a binding that exists only in that world. Page scripts can't see either. Crops come
//! from `Page.captureScreenshot`, so every pin gets one without a key press.
//!
//! Only the methods in `ALLOWED` are ever sent, and `Runtime.evaluate` only into our world.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

pub const WORLD: &str = "cockpit";
const BINDING: &str = "__cockpitSend";
/// Tab keys of this mode: `launch:<targetId>`.
pub const PREFIX: &str = "launch:";

/// Every DevTools method Cockpit may send. Nothing that reads cookies, storage or the network.
pub const ALLOWED: &[&str] = &[
    "Target.setDiscoverTargets", "Target.setAutoAttach", "Target.createTarget", "Target.activateTarget", "Target.getTargets",
    "Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.navigate", "Page.reload", "Page.captureScreenshot",
    "Runtime.enable", "Runtime.addBinding", "Runtime.evaluate", "Runtime.runIfWaitingForDebugger",
];

/// Whether a call may go out: allowlisted, and evaluation only inside our own world.
pub fn allowed(method: &str, params: &Value) -> bool {
    ALLOWED.contains(&method) && (method != "Runtime.evaluate" || params["contextId"].is_i64())
}

/// The scripts injected into every page of the profile, in order.
pub fn overlay_source() -> String {
    // The overlay waits for the DOM: these run at document start, before <html> exists.
    format!(
        "{}\n;(() => {{ if (!globalThis.__cockpitShim) return; const go = () => {{\n{}\n;\n{}\n}}; document.readyState === \"loading\" ? addEventListener(\"DOMContentLoaded\", go, {{ once: true }}) : go(); }})();",
        include_str!("../../browser/extension/launch.js"), include_str!("../../browser/extension/lib.js"), include_str!("../../browser/extension/annotator.js"),
    )
}

/// What the page asked for, handled by whoever owns the browser (the app, or a test).
pub type OnCall = Arc<dyn Fn(&Cdp, &str, &Value) -> Value + Send + Sync>;
/// Tab lifecycle: (event, tab key, payload) for attached / navigated / closed / gone.
pub type OnTab = Arc<dyn Fn(&str, &str, &Value) + Send + Sync>;

/// One Chrome over a DevTools pipe.
pub struct Cdp {
    w: Mutex<std::fs::File>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    /// DevTools session → target (one per page).
    sessions: Mutex<HashMap<String, String>>,
    /// Target → our world's current execution context.
    worlds: Mutex<HashMap<String, i64>>,
    child: Mutex<Option<std::process::Child>>,
}

impl Cdp {
    /// Sends one allowlisted call and waits for its answer.
    pub fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
        if !allowed(method, &params) {
            return Err(format!("{method} is not allowed"));
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = s.into();
        }
        let (tx, rx) = std::sync::mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut bytes = msg.to_string().into_bytes();
        bytes.push(0);
        if self.w.lock().unwrap().write_all(&bytes).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("the Cockpit browser closed".into());
        }
        let r = rx.recv_timeout(Duration::from_secs(20));
        self.pending.lock().unwrap().remove(&id);
        let r = r.map_err(|_| format!("{method}: no answer from the browser"))?;
        match r.get("error") {
            Some(e) => Err(format!("{method}: {}", e["message"].as_str().unwrap_or("failed"))),
            None => Ok(r["result"].clone()),
        }
    }

    fn session_of(&self, target: &str) -> Option<String> {
        self.sessions.lock().unwrap().iter().find(|(_, t)| *t == target).map(|(s, _)| s.clone())
    }

    /// Waits a moment for a new target's session (attach races createTarget's answer).
    fn wait_session(&self, target: &str) -> Option<String> {
        for _ in 0..50 {
            if let Some(s) = self.session_of(target) {
                return Some(s);
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        None
    }

    /// Evaluates in our world of a tab. The page's own world is never touched.
    pub fn eval_world(&self, target: &str, expr: &str) -> Result<Value, String> {
        let session = self.session_of(target).ok_or("that tab is gone")?;
        let ctx = *self.worlds.lock().unwrap().get(target).ok_or("the overlay isn't loaded in that tab")?;
        self.call(Some(&session), "Runtime.evaluate", json!({ "expression": expr, "contextId": ctx, "returnByValue": true, "awaitPromise": true }))
    }

    /// Sends a message to the overlay of a tab (refresh, unlinked, hide, show).
    pub fn push(&self, target: &str, msg: &Value) {
        let _ = self.eval_world(target, &format!("globalThis.__cockpitPush && __cockpitPush({msg})"));
    }

    pub fn targets(&self) -> Vec<String> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// Opens a tab and loads `url` once its session is set up (so the overlay is there first).
    /// `before` runs with the new target before the page loads (to link it).
    pub fn open(&self, url: &str, before: impl FnOnce(&str)) -> Result<String, String> {
        let r = self.call(None, "Target.createTarget", json!({ "url": "about:blank" }))?;
        let target = r["targetId"].as_str().ok_or("no tab")?.to_owned();
        let session = self.wait_session(&target).ok_or("the new tab didn't attach")?;
        before(&target);
        self.call(Some(&session), "Page.navigate", json!({ "url": url }))?;
        let _ = self.call(None, "Target.activateTarget", json!({ "targetId": target }));
        Ok(target)
    }

    pub fn reload(&self, target: &str) -> Result<(), String> {
        let session = self.session_of(target).ok_or("that tab is gone")?;
        self.call(Some(&session), "Page.reload", json!({})).map(|_| ())
    }

    /// The visible part of a tab, overlay hidden.
    pub fn screenshot(&self, target: &str) -> Result<String, String> {
        let session = self.session_of(target).ok_or("that tab is gone")?;
        self.push(target, &json!({ "type": "hide" }));
        let r = self.call(Some(&session), "Page.captureScreenshot", json!({ "format": "png" }));
        self.push(target, &json!({ "type": "show" }));
        Ok(format!("data:image/png;base64,{}", r?["data"].as_str().unwrap_or_default()))
    }

    /// A pin's crop and thumbnail. `rect` is in viewport CSS pixels; the shim has already hidden
    /// the overlay and drawn black boxes over secret fields.
    pub fn crop(&self, target: &str, rect: &Value) -> Result<Value, String> {
        let session = self.session_of(target).ok_or("that tab is gone")?;
        let f = |k: &str| rect[k].as_f64().unwrap_or(0.0);
        let pad = 16.0;
        // Page coordinates: the clip is measured from the document's origin.
        let (x, y) = ((f("x") + f("sx") - pad).max(0.0), (f("y") + f("sy") - pad).max(0.0));
        let (w, h) = ((f("w") + pad * 2.0).max(1.0), (f("h") + pad * 2.0).max(1.0));
        let crop = self.call(Some(&session), "Page.captureScreenshot", json!({ "format": "png", "clip": { "x": x, "y": y, "width": w, "height": h, "scale": 1 } }))?;
        let scale = (320.0 / w).min(1.0) / f("dpr").max(1.0);
        let thumb = self.call(Some(&session), "Page.captureScreenshot", json!({ "format": "jpeg", "quality": 70, "clip": { "x": x, "y": y, "width": w, "height": h, "scale": scale } }))?;
        Ok(json!({
            "crop": format!("data:image/png;base64,{}", crop["data"].as_str().unwrap_or_default()),
            "thumb": format!("data:image/jpeg;base64,{}", thumb["data"].as_str().unwrap_or_default()),
        }))
    }

    pub fn alive(&self) -> bool {
        self.child.lock().unwrap().as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none())
    }

    pub fn kill(&self) {
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

/// Where a Chromium browser lives: `MR_BROWSER`, else Chrome, Chromium, Brave or Edge.
pub fn find_browser() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("MR_BROWSER") && !p.is_empty() {
        return Some(p.into());
    }
    let home = dirs::home_dir().unwrap_or_default();
    #[cfg(target_os = "macos")]
    let apps = ["Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge"].iter()
        .flat_map(|n| [std::path::PathBuf::from(format!("/Applications/{n}.app/Contents/MacOS/{n}")), home.join(format!("Applications/{n}.app/Contents/MacOS/{n}"))])
        .collect::<Vec<_>>();
    #[cfg(not(target_os = "macos"))]
    let apps = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"].iter()
        .flat_map(|n| ["/usr/bin", "/usr/local/bin", "/snap/bin"].map(|d| std::path::PathBuf::from(format!("{d}/{n}"))))
        .chain(std::iter::once(home.join(".local/bin/chrome")))
        .collect::<Vec<_>>();
    apps.into_iter().find(|p| p.is_file())
}

/// Starts Chrome on `profile` with the DevTools pipe, injects the overlay into every page, and
/// routes the overlay's calls to `on_call`. `on_tab` hears about tabs coming and going.
#[cfg(unix)]
pub fn launch(browser: &std::path::Path, profile: &std::path::Path, extra: &[&str], on_call: OnCall, on_tab: OnTab) -> Result<Arc<Cdp>, String> {
    use std::os::fd::FromRawFd;
    use std::os::unix::process::CommandExt;
    std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    let pipe = || -> Result<(i32, i32), String> {
        let mut fds = [0; 2];
        // SAFETY: fds is a valid 2-int buffer.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err("pipe failed".into());
        }
        for fd in fds {
            // Close-on-exec: Chrome gets only the two ends dup'd to 3 and 4.
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
        Ok((fds[0], fds[1]))
    };
    let (to_chrome_r, to_chrome_w) = pipe()?;
    let (from_chrome_r, from_chrome_w) = pipe()?;
    let mut cmd = std::process::Command::new(browser);
    cmd.arg(format!("--user-data-dir={}", profile.display()))
        .args(["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"])
        .args(extra)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // SAFETY: only async-signal-safe calls (dup2) between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            // Move both out of the way first: either may already be fd 3 or 4.
            let (a, b) = (libc::fcntl(to_chrome_r, libc::F_DUPFD, 10), libc::fcntl(from_chrome_w, libc::F_DUPFD, 10));
            if a < 0 || b < 0 || libc::dup2(a, 3) < 0 || libc::dup2(b, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(|e| format!("can't start {}: {e}", browser.display()))?;
    // SAFETY: we own these fds; the child has its copies.
    unsafe {
        libc::close(to_chrome_r);
        libc::close(from_chrome_w);
    }
    let w = unsafe { std::fs::File::from_raw_fd(to_chrome_w) };
    let r = unsafe { std::fs::File::from_raw_fd(from_chrome_r) };
    let cdp = Arc::new(Cdp {
        w: Mutex::new(w), next: AtomicU64::new(0), pending: Mutex::default(), sessions: Mutex::default(), worlds: Mutex::default(), child: Mutex::new(Some(child)),
    });
    let reader = cdp.clone();
    let script = overlay_source();
    std::thread::spawn(move || {
        let mut r = std::io::BufReader::new(r);
        loop {
            let mut buf = vec![];
            match r.read_until(0, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            buf.pop();
            let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
            if let Some(id) = msg["id"].as_u64() {
                if let Some(tx) = reader.pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(msg);
                }
                continue;
            }
            on_event(&reader, &msg, &script, &on_call, &on_tab);
        }
        // Chrome quit: every tab is gone.
        for t in reader.sessions.lock().unwrap().drain().map(|(_, t)| t) {
            on_tab("closed", &format!("{PREFIX}{t}"), &json!({}));
        }
        reader.pending.lock().unwrap().clear();
        on_tab("gone", "", &json!({}));
    });
    cdp.call(None, "Target.setDiscoverTargets", json!({ "discover": true }))?;
    cdp.call(None, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }))?;
    Ok(cdp)
}

#[cfg(not(unix))]
pub fn launch(_: &std::path::Path, _: &std::path::Path, _: &[&str], _: OnCall, _: OnTab) -> Result<Arc<Cdp>, String> {
    Err("The Cockpit browser needs macOS or Linux for now".into())
}

fn on_event(cdp: &Arc<Cdp>, msg: &Value, script: &str, on_call: &OnCall, on_tab: &OnTab) {
    let p = &msg["params"];
    let session = msg["sessionId"].as_str().unwrap_or_default().to_owned();
    match msg["method"].as_str().unwrap_or_default() {
        "Target.attachedToTarget" => {
            let info = &p["targetInfo"];
            let sid = p["sessionId"].as_str().unwrap_or_default().to_owned();
            if info["type"] != "page" {
                // Workers and the like: let them run, never instrument them.
                let cdp = cdp.clone();
                std::thread::spawn(move || { let _ = cdp.call(Some(&sid), "Runtime.runIfWaitingForDebugger", json!({})); });
                return;
            }
            let target = info["targetId"].as_str().unwrap_or_default().to_owned();
            cdp.sessions.lock().unwrap().insert(sid.clone(), target.clone());
            let (cdp, script, on_tab, info) = (cdp.clone(), script.to_owned(), on_tab.clone(), info.clone());
            // Off the reader: each call waits for an answer the reader delivers.
            std::thread::spawn(move || {
                let _ = cdp.call(Some(&sid), "Runtime.addBinding", json!({ "name": BINDING, "executionContextName": WORLD }));
                let _ = cdp.call(Some(&sid), "Runtime.enable", json!({}));
                let _ = cdp.call(Some(&sid), "Page.enable", json!({}));
                let _ = cdp.call(Some(&sid), "Page.addScriptToEvaluateOnNewDocument", json!({ "source": script, "worldName": WORLD, "runImmediately": true }));
                let _ = cdp.call(Some(&sid), "Runtime.runIfWaitingForDebugger", json!({}));
                on_tab("attached", &format!("{PREFIX}{target}"), &json!({ "url": info["url"], "title": info["title"], "opener": info["openerId"].as_str().map(|o| format!("{PREFIX}{o}")) }));
            });
        }
        "Target.detachedFromTarget" => {
            if let Some(t) = cdp.sessions.lock().unwrap().remove(p["sessionId"].as_str().unwrap_or_default()) {
                cdp.worlds.lock().unwrap().remove(&t);
                on_tab("closed", &format!("{PREFIX}{t}"), &json!({}));
            }
        }
        "Target.targetInfoChanged" => {
            let info = &p["targetInfo"];
            if info["type"] == "page" {
                on_tab("navigated", &format!("{PREFIX}{}", info["targetId"].as_str().unwrap_or_default()), &json!({ "url": info["url"], "title": info["title"] }));
            }
        }
        "Runtime.executionContextsCleared" => {
            if let Some(t) = cdp.sessions.lock().unwrap().get(&session) {
                cdp.worlds.lock().unwrap().remove(t);
            }
        }
        "Runtime.executionContextCreated" => {
            let c = &p["context"];
            let Some(target) = cdp.sessions.lock().unwrap().get(&session).cloned() else { return };
            // Our world in the tab's main frame (whose id is the target's).
            if c["name"] == WORLD && c["auxData"]["frameId"].as_str() == Some(&target) {
                cdp.worlds.lock().unwrap().insert(target, c["id"].as_i64().unwrap_or(0));
            }
        }
        "Runtime.bindingCalled" if p["name"] == BINDING => {
            let Some(target) = cdp.sessions.lock().unwrap().get(&session).cloned() else { return };
            // Only from our world; the binding doesn't exist anywhere else, but check anyway.
            if cdp.worlds.lock().unwrap().get(&target).copied() != p["executionContextId"].as_i64() {
                return;
            }
            let Ok(call) = serde_json::from_str::<Value>(p["payload"].as_str().unwrap_or_default()) else { return };
            let (cdp, on_call) = (cdp.clone(), on_call.clone());
            std::thread::spawn(move || {
                let tab = format!("{PREFIX}{target}");
                let reply = on_call(&cdp, &tab, &call["msg"]);
                let _ = cdp.eval_world(&target, &format!("__cockpitReply({}, {reply})", call["id"]));
            });
        }
        _ => {}
    }
}

/// Answers the shim's own requests (capture, focus); everything else is a core request.
pub fn shim_call(cdp: &Cdp, tab: &str, msg: &Value, core: impl Fn(&Value) -> Value) -> Value {
    let target = tab.strip_prefix(PREFIX).unwrap_or(tab);
    match msg["type"].as_str() {
        Some("capture") => cdp.crop(target, &msg["rect"]).map(|mut v| { v["redactions"] = msg["redact"].as_array().map(|a| a.len()).unwrap_or(0).into(); v }).unwrap_or_else(|e| json!({ "error": e })),
        Some("focus_tab") => {
            let t = msg["tab"].as_str().unwrap_or_default();
            let ok = t.strip_prefix(PREFIX).is_some_and(|t| cdp.call(None, "Target.activateTarget", json!({ "targetId": t })).is_ok());
            json!({ "ok": ok })
        }
        Some("call") => {
            let mut m = msg["msg"].clone();
            m["tab"] = tab.into();
            core(&m)
        }
        _ => json!({ "error": "unknown" }),
    }
}

// ---- the app side ----------------------------------------------------------------------------

/// The running Cockpit browser, if any, and the session its new tabs join.
#[derive(Default)]
pub struct Launched {
    cdp: Mutex<Option<Arc<Cdp>>>,
    last: Mutex<Option<String>>,
}

pub fn running(app: &tauri::AppHandle) -> Option<Arc<Cdp>> {
    use tauri::Manager;
    app.state::<Launched>().cdp.lock().unwrap().clone().filter(|c| c.alive())
}

/// Starts the Cockpit browser unless it's running.
fn ensure(app: &tauri::AppHandle) -> Result<Arc<Cdp>, String> {
    use tauri::Manager;
    if let Some(c) = running(app) {
        return Ok(c);
    }
    let browser = find_browser().ok_or("No Chrome found. Install Google Chrome (or Chromium, Brave, Edge), or set MR_BROWSER.")?;
    let profile = crate::selfbuild::data_dir(app).join("browser-profile");
    let a = app.clone();
    let on_call: OnCall = Arc::new(move |cdp, tab, msg| shim_call(cdp, tab, msg, |m| crate::browser::request(&a, m)));
    let a = app.clone();
    let on_tab: OnTab = Arc::new(move |ev, tab, p| on_tab(&a, ev, tab, p));
    let cdp = launch(&browser, &profile, &[], on_call, on_tab)?;
    *app.state::<Launched>().cdp.lock().unwrap() = Some(cdp.clone());
    Ok(cdp)
}

fn on_tab(app: &tauri::AppHandle, ev: &str, tab: &str, p: &Value) {
    use tauri::Manager;
    let linked = |t: &str| app.state::<crate::browser::Browser>().model.lock().unwrap().link(t).map(|l| l.session.clone());
    match ev {
        // A tab opened from a linked one joins its session; one you open by hand in this profile
        // joins the session you last opened a page for. The profile is Cockpit's own.
        "attached" => {
            if linked(tab).is_some() {
                return;
            }
            let session = p["opener"].as_str().and_then(linked).or_else(|| app.state::<Launched>().last.lock().unwrap().clone());
            if let Some(session) = session {
                crate::browser::request(app, &json!({ "type": "link", "tab": tab, "url": p["url"], "title": p["title"], "session": session }));
            }
        }
        "navigated" if linked(tab).is_some() => {
            crate::browser::request(app, &json!({ "type": "navigated", "tab": tab, "url": p["url"], "title": p["title"] }));
        }
        "closed" => {
            crate::browser::request(app, &json!({ "type": "closed", "tab": tab }));
        }
        "gone" => *app.state::<Launched>().cdp.lock().unwrap() = None,
        _ => {}
    }
}

/// Opens `url` in the Cockpit browser, linked to `session`. A tab of that session already on
/// that page is brought to the front instead.
pub fn open(app: &tauri::AppHandle, session: &str, url: &str) -> Result<String, String> {
    use tauri::Manager;
    let url = with_scheme(url.trim());
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http and https pages can be annotated".into());
    }
    let cdp = ensure(app)?;
    *app.state::<Launched>().last.lock().unwrap() = Some(session.to_owned());
    let mine = app.state::<crate::browser::Browser>().model.lock().unwrap().links_of(session);
    let live = cdp.targets();
    if let Some(l) = mine.iter().find(|l| l.tab.strip_prefix(PREFIX).is_some_and(|t| live.iter().any(|x| x == t)) && crate::browser::same_page(&l.url, &url)) {
        let t = l.tab.strip_prefix(PREFIX).unwrap_or_default().to_owned();
        let _ = cdp.call(None, "Target.activateTarget", json!({ "targetId": t }));
        start_annotating(cdp, t);
        return Ok(l.tab.clone());
    }
    let mut refused = None;
    let target = cdp.open(&url, |target| {
        let tab = format!("{PREFIX}{target}");
        let already = app.state::<crate::browser::Browser>().model.lock().unwrap().link(&tab).is_some();
        if !already {
            let r = crate::browser::request(app, &json!({ "type": "link", "tab": tab, "url": url, "title": "", "session": session }));
            refused = r["error"].is_string().then(|| r["message"].as_str().unwrap_or("couldn't link the tab").to_owned());
        }
    })?;
    // The page opened but isn't linked: say why instead of showing a page with no overlay.
    if let Some(e) = refused {
        return Err(e);
    }
    start_annotating(cdp, target.clone());
    Ok(format!("{PREFIX}{target}"))
}

/// A typed address as a URL: `localhost:3000` is a dev server (http), anything else https.
pub fn with_scheme(url: &str) -> String {
    if url.contains("://") {
        return url.to_owned();
    }
    let host = url.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map(|(h, _)| h).unwrap_or(host);
    let local = matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]") || host.ends_with(".localhost");
    format!("{}://{url}", if local { "http" } else { "https" })
}

/// You asked to annotate this page: the overlay starts in annotate mode, so the next click pins.
/// Waits (off this thread) for the overlay to load.
fn start_annotating(cdp: Arc<Cdp>, target: String) {
    std::thread::spawn(move || {
        for _ in 0..100 {
            let r = cdp.eval_world(&target, "globalThis.__cockpitOverlay ? (__cockpitPush({ type: 'annotate' }), true) : false");
            if r.is_ok_and(|v| v["result"]["value"] == true) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

/// Tells a launched tab's overlay something (refresh, unlinked); a no-op for extension tabs.
pub fn push(app: &tauri::AppHandle, tab: &str, msg: &Value) {
    if let (Some(t), Some(cdp)) = (tab.strip_prefix(PREFIX), running(app)) {
        let (cdp, t, msg) = (cdp.clone(), t.to_owned(), msg.clone());
        std::thread::spawn(move || cdp.push(&t, &msg));
    }
}

pub fn push_all(app: &tauri::AppHandle, msg: &Value) {
    if let Some(cdp) = running(app) {
        let msg = msg.clone();
        std::thread::spawn(move || {
            for t in cdp.targets() {
                cdp.push(&t, &msg);
            }
        });
    }
}

/// The agent's reload / screenshot on a launched tab.
pub fn agent_action(app: &tauri::AppHandle, tab: &str, action: &str) -> Result<Value, String> {
    let cdp = running(app).ok_or("The Cockpit browser isn't open any more.")?;
    let t = tab.strip_prefix(PREFIX).unwrap_or(tab);
    match action {
        "reload" => cdp.reload(t).map(|_| json!({ "ok": true })),
        _ => cdp.screenshot(t).map(|image| json!({ "ok": true, "image": image })),
    }
}

/// Closes the Cockpit browser with the app.
pub fn stop(app: &tauri::AppHandle) {
    if let Some(c) = running(app) {
        c.kill();
    }
}

#[tauri::command(async)]
pub fn browser_launch_open(app: tauri::AppHandle, session: String, url: String) -> Result<String, String> {
    open(&app, &session, &url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowlisted_methods_and_world_scoped_evaluation() {
        for m in ["Network.getAllCookies", "Storage.getCookies", "Network.enable", "Target.attachToBrowserTarget", "Runtime.callFunctionOn", "Input.dispatchKeyEvent"] {
            assert!(!allowed(m, &json!({})), "{m}");
        }
        assert!(!allowed("Runtime.evaluate", &json!({ "expression": "document.cookie" })), "the page's own world");
        assert!(allowed("Runtime.evaluate", &json!({ "expression": "1", "contextId": 7 })));
        assert!(allowed("Page.captureScreenshot", &json!({})));
    }

    #[test]
    fn typed_addresses_get_a_scheme() {
        assert_eq!(with_scheme("localhost:3000"), "http://localhost:3000");
        assert_eq!(with_scheme("127.0.0.1:5173/settings"), "http://127.0.0.1:5173/settings");
        assert_eq!(with_scheme("app.localhost"), "http://app.localhost");
        assert_eq!(with_scheme("staging.example.com/x"), "https://staging.example.com/x");
        assert_eq!(with_scheme("http://example.com"), "http://example.com");
    }

    #[test]
    fn the_overlay_loads_behind_the_shim() {
        let s = overlay_source();
        let (shim, lib, ann) = (s.find("__cockpitReply").unwrap(), s.find("__cockpitLib = lib").unwrap(), s.find("__cockpitOverlay").unwrap());
        assert!(shim < lib && lib < ann);
    }

    /// Real Chrome (Chrome for Testing in CI-less runs): `MR_BROWSER=<binary> cargo test browser_launch -- --ignored`.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn drives_a_real_chrome_over_the_pipe() {
        let Some(browser) = find_browser() else { return };
        let dir = std::env::temp_dir().join(format!("mr-launch-{}", ulid::Ulid::new()));
        let fixture = dir.join("page.html");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&fixture, r#"<html><body style="height:3000px"><input type="password" value="hunter2"><button data-testid="save" style="position:absolute;left:100px;top:1200px;width:120px;height:36px">Save</button><script>window.mainWorld = typeof __cockpitSend</script></body></html>"#).unwrap();
        let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
        let c2 = calls.clone();
        let on_call: OnCall = Arc::new(move |cdp, tab, msg| {
            c2.lock().unwrap().push(msg.clone());
            shim_call(cdp, tab, msg, |m| match m["type"].as_str() {
                Some("tab_state") => json!({ "linked": { "session": "A", "title": "settings", "marker": "S" }, "blocked": false, "count": { "pins": 0, "tabs": 1 }, "open": [], "page": [], "carryable": 0 }),
                _ => json!({ "ok": true }),
            })
        });
        let cdp = launch(&browser, &dir.join("profile"), &["--headless=new", "--window-size=1000,800"], on_call, Arc::new(|_, _, _| {})).unwrap();
        let target = cdp.open(&format!("file://{}", fixture.display()), |_| {}).unwrap();
        // The overlay comes up in our world and asks for its state.
        let mut ok = false;
        for _ in 0..100 {
            if calls.lock().unwrap().iter().any(|c| c["type"] == "call" && c["msg"]["type"] == "tab_state" && c["msg"]["url"].as_str().is_some_and(|u| u.starts_with("file:"))) { ok = true; break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ok, "the overlay never called in");
        // The overlay's code lives in our world.
        let session = cdp.session_of(&target).unwrap();
        let ctx = *cdp.worlds.lock().unwrap().get(&target).unwrap();
        assert_eq!(cdp.call(Some(&session), "Runtime.evaluate", json!({ "expression": "typeof __cockpitLib", "contextId": ctx, "returnByValue": true })).unwrap()["result"]["value"], "object");
        // A crop of an element below the fold, after scrolling to it.
        cdp.eval_world(&target, "scrollTo(0, 1000)").unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let rect = cdp.eval_world(&target, "(() => { const r = document.querySelector('[data-testid=save]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, sx: scrollX, sy: scrollY, dpr: devicePixelRatio }; })()").unwrap()["result"]["value"].clone();
        let shot = cdp.crop(&target, &rect).unwrap();
        let png = crate::browser::b64_decode(shot["crop"].as_str().unwrap().split_once(',').unwrap().1).unwrap();
        // 120×36 + 16 px padding on each side, at device scale 1 in headless.
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 152);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 68);
        // The shim round trip: a call answered by the core, and a capture with a redaction box.
        let r = cdp.eval_world(&target, "chrome.runtime.sendMessage({ type: 'call', msg: { type: 'ping' } })").unwrap();
        assert_eq!(r["result"]["value"]["ok"], true, "{r}");
        let r = cdp.eval_world(&target, "chrome.runtime.sendMessage({ type: 'capture', rect: { x: 100, y: 200, w: 120, h: 36 }, dpr: 1, redact: [{ x: 100, y: 200, w: 20, h: 20 }] }).then(r => [r.redactions, r.crop.length > 100, document.querySelectorAll('cockpit-redact').length])").unwrap();
        assert_eq!(r["result"]["value"], json!([1, true, 0]), "{r}");
        cdp.kill();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The UX walk host (scripts/e2e/annotate-walk.sh): headless Chrome over the pipe, the real
    /// core model behind it, a tab already linked the way "Annotate a page…" links it, and a
    /// DevTools port for the driver's trusted input. Runs until `MR_WALK_DIR/done` appears.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn ux_walk_host() {
        let (Some(browser), Ok(dir)) = (find_browser(), std::env::var("MR_WALK_DIR")) else { return };
        let dir = std::path::PathBuf::from(dir);
        let model: Arc<Mutex<crate::browser::Model>> = Arc::default();
        let sessions = vec![crate::browser::SessionInfo { id: "A".into(), title: "Settings redesign".into(), folder: "/tmp".into() }];
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let run = {
            let (model, sessions, data, dir) = (model.clone(), sessions.clone(), data.clone(), dir.clone());
            move |m: &Value| -> (Value, bool) {
                let ports = HashMap::new();
                let ctx = crate::browser::Ctx { sessions: &sessions, focused: Some("A"), ports: &ports, data_dir: &data };
                let out = crate::browser::handle(&model.lock().unwrap(), &ctx, m);
                for (_, kind, p) in &out.events {
                    model.lock().unwrap().apply(kind, p);
                }
                if let Some((_, text, _)) = &out.send {
                    std::fs::write(dir.join("sent.txt"), text).unwrap();
                }
                (out.reply, !out.events.is_empty())
            }
        };
        let run = Arc::new(run);
        let r2 = run.clone();
        let on_call: OnCall = Arc::new(move |cdp, tab, msg| {
            let changed = std::cell::Cell::new(false);
            let reply = shim_call(cdp, tab, msg, |m| { let (r, c) = r2(m); changed.set(c); r });
            if changed.get() {
                // The app pushes refresh to every tab after a change.
                for t in cdp.targets() {
                    cdp.push(&t, &json!({ "type": "refresh" }));
                }
            }
            reply
        });
        let cdp = launch(&browser, &dir.join("profile"), &["--headless=new", "--window-size=1280,860", "--remote-debugging-port=9337"], on_call, Arc::new(|_, _, _| {})).unwrap();
        let url = std::env::var("MR_WALK_URL").unwrap_or_else(|_| "http://127.0.0.1:18766/app.html".into());
        let target = cdp.open(&url, |t| { run(&json!({ "type": "link", "tab": format!("{PREFIX}{t}"), "url": url, "title": "Acme settings", "session": "A" })); }).unwrap();
        start_annotating(cdp.clone(), target);
        std::fs::write(dir.join("ready"), "").unwrap();
        for _ in 0..1200 {
            if dir.join("done").exists() { break; }
            std::thread::sleep(Duration::from_millis(100));
        }
        cdp.kill();
    }
}
