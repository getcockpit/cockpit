// Cockpit annotations: the service worker. It is only a transport. It talks to Cockpit through
// Chrome native messaging (no network), injects the overlay into tabs you link, and captures crops.
// Content scripts never name a tab themselves: the worker fills it in from the sender.

const HOST = "dev.getcockpit.browser";
const LOCALHOST = ["http://localhost/*", "http://127.0.0.1/*"];

let port = null;
let ready = null;
let seq = 0;
const waiting = new Map();

async function clientId() {
  const s = await chrome.storage.local.get("client");
  if (s.client) return s.client;
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await chrome.storage.local.set({ client: id });
  return id;
}

const tabKey = async (tabId) => `${await clientId()}:${tabId}`;
const tabIdOf = (key) => Number(String(key).split(":")[1]);

function connect() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      ready = null;
      return reject(new Error("not_set_up"));
    }
    port.onMessage.addListener(onCore);
    port.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message || "";
      const err = /not found|forbidden/i.test(why) ? "not_set_up" : "cockpit_not_running";
      port = null;
      ready = null;
      for (const [, w] of waiting) w.reject(new Error(err));
      waiting.clear();
      reject(new Error(err));
    });
    clientId().then((client) => {
      const id = ++seq;
      waiting.set(id, {
        resolve: (r) => {
          // Cockpit updated the unpacked folder: load the new files.
          if (r.version && r.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
          resolve();
        },
        reject,
      });
      port.postMessage({ type: "hello", id, client, version: chrome.runtime.getManifest().version });
    });
  });
  return ready;
}

/** One request to Cockpit; resolves with its reply. */
async function call(msg) {
  await connect();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("timeout")); }, 15000);
    waiting.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    port.postMessage({ ...msg, id });
  });
}

async function onCore(msg) {
  if (msg.type === "error") {
    for (const [, w] of waiting) w.reject(new Error(msg.error));
    waiting.clear();
    return;
  }
  if (msg.re !== undefined && waiting.has(msg.re)) {
    const w = waiting.get(msg.re);
    waiting.delete(msg.re);
    return w.resolve(msg);
  }
  if (msg.type === "changed") return refreshAll();
  if (msg.type === "links" && !msg.linked) {
    const mine = String(msg.tab).startsWith(`${await clientId()}:`);
    if (mine) tell(tabIdOf(msg.tab), { type: "unlinked" });
    return;
  }
  if (msg.type === "do") return doAction(msg);
}

/** The agent's two allowed actions, on a linked tab only (Cockpit checks the link). */
async function doAction({ req, action, tab }) {
  const tabId = tabIdOf(tab);
  try {
    if (action === "reload") {
      await chrome.tabs.reload(tabId);
      port?.postMessage({ type: "done", req, ok: true });
    } else if (action === "screenshot") {
      const t = await chrome.tabs.get(tabId);
      if (!t.active) throw new Error("the tab isn't the active one in its window");
      await tell(tabId, { type: "hide" });
      const image = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
      await tell(tabId, { type: "show" });
      port?.postMessage({ type: "done", req, ok: true, image });
    } else throw new Error("not allowed");
  } catch (e) {
    port?.postMessage({ type: "done", req, ok: false, error: String(e.message || e) });
  }
}

async function injected() {
  return (await chrome.storage.session.get("injected")).injected || [];
}

async function setInjected(tabId, on) {
  const list = new Set(await injected());
  on ? list.add(tabId) : list.delete(tabId);
  await chrome.storage.session.set({ injected: [...list] });
}

function tell(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => setInjected(tabId, false));
}

async function refreshAll() {
  for (const id of await injected()) tell(id, { type: "refresh" });
}

/** Injects the overlay into a linked tab (needs activeTab or the localhost permission). */
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["lib.js", "annotator.js"] });
  await setInjected(tabId, true);
}

async function link(tabId, url, title, session) {
  const r = await call({ type: "link", tab: await tabKey(tabId), url, title, session });
  if (r.linked) await inject(tabId);
  return r;
}

// The tab closed: its link drops.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await setInjected(tabId, false);
  call({ type: "closed", tab: await tabKey(tabId) }).catch(() => {});
});

// A linked tab navigated. Localhost (with the optional permission) gets its overlay back, and the
// session's own app links itself. Other sites need ⌥⇧A again: activeTab ends on navigation.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(tab.url);
  const allowed = local && (await chrome.permissions.contains({ origins: LOCALHOST }));
  if (!allowed) return;
  try {
    const key = await tabKey(tabId);
    await call({ type: "navigated", tab: key, url: tab.url, title: tab.title || "" });
    const r = await call({ type: "auto_link", tab: key, url: tab.url, title: tab.title || "" });
    if (r.linked) await inject(tabId);
  } catch { /* Cockpit isn't running */ }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

async function handle(msg, sender) {
  const fromTab = sender.tab?.id;
  switch (msg.type) {
    // From the overlay: the tab is always the sender's own.
    case "call": {
      if (fromTab === undefined) throw new Error("no tab");
      const key = await tabKey(fromTab);
      if (msg.msg.type === "unlink") await setInjected(fromTab, false);
      return call({ ...msg.msg, tab: key });
    }
    case "capture": return capture(sender.tab, msg);
    case "focus_tab": {
      const id = tabIdOf(msg.tab);
      const t = await chrome.tabs.update(id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true };
    }
    // From the popup.
    case "popup_state": {
      const key = await tabKey(msg.tabId);
      const r = await call({ type: "sessions", tab: key, url: msg.url });
      // A linked tab whose overlay went away (navigation) gets it back: the popup granted activeTab.
      if (r.linked && !r.blocked) await inject(msg.tabId).catch(() => {});
      return { ...r, localPermission: await chrome.permissions.contains({ origins: LOCALHOST }) };
    }
    case "popup_link": return link(msg.tabId, msg.url, msg.title, msg.session);
    case "popup_unlink": {
      await tell(msg.tabId, { type: "unlinked" });
      await setInjected(msg.tabId, false);
      return call({ type: "unlink", tab: await tabKey(msg.tabId) });
    }
    default: throw new Error("unknown");
  }
}

/** The visible tab, cropped to `rect` (CSS px in the viewport) with secret fields blacked out. */
async function capture(tab, { rect, dpr, redact }) {
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const k = bmp.width / Math.max(1, Math.round(bmp.width / dpr)) || dpr;
  const pad = 16;
  const x = Math.max(0, Math.floor((rect.x - pad) * k));
  const y = Math.max(0, Math.floor((rect.y - pad) * k));
  const w = Math.max(1, Math.min(bmp.width - x, Math.ceil((rect.w + pad * 2) * k)));
  const h = Math.max(1, Math.min(bmp.height - y, Math.ceil((rect.h + pad * 2) * k)));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext("2d");
  g.drawImage(bmp, x, y, w, h, 0, 0, w, h);
  g.fillStyle = "#000";
  for (const r of redact || []) g.fillRect(r.x * k - x, r.y * k - y, r.w * k, r.h * k);
  const crop = await toDataUrl(await canvas.convertToBlob({ type: "image/png" }));
  const scale = Math.min(1, 320 / w);
  const t = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
  const thumb = await toDataUrl(await t.convertToBlob({ type: "image/jpeg", quality: 0.7 }));
  return { crop, thumb, redactions: (redact || []).length };
}

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(s)}`;
}
