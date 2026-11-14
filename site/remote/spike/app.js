// Cockpit Remote, preview (decision 46): this page is the same for every Cockpit owner. It pairs
// with *your* Mac from that Mac's pairing text, talks to it over iroh (relay, end-to-end
// encrypted, `remote_web` = crates/remote-web), and turns on Web Push with your Mac's own key.
// Nothing about you or your Mac is ever sent to this site.
// ?v=N: a new wasm must not come from Safari's cache (bump with each published build).
import init, { WebPeer } from "./pkg/remote_web.js?v=2";

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };
const log = (...a) => { $("log").textContent += a.join(" ") + "\n"; };
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

let link = null;
let pushKey = null;
const pending = new Map(); // request_id → {session, text}
const titles = new Map(); // session → first prompt
let events = 0;

function render() {
  $("summary").textContent = pending.size ? `${pending.size} need${pending.size === 1 ? "s" : ""} you` : `All quiet · ${events} events`;
  $("asks").replaceChildren(...[...pending.values()].map((a) => {
    const d = document.createElement("div");
    d.className = "card needs";
    d.innerHTML = `<b></b><span class="dim"></span>`;
    d.querySelector("b").textContent = titles.get(a.session) ?? "Session";
    d.querySelector("span").textContent = a.text;
    return d;
  }));
}

function onEvent(e) {
  events++;
  const p = e.payload ?? {};
  if (e.kind === "ui.session_requested") titles.set(e.session_id, String(p.prompt ?? "").slice(0, 60));
  if (e.kind === "sidecar.permission_request" && !p.auto_allowed) {
    const text = p.tool === "AskUserQuestion" ? `Claude asks: ${p.input?.questions?.[0]?.question ?? ""}` : `Allow ${p.tool}? ${p.input?.command ?? p.input?.file_path ?? ""}`;
    pending.set(p.request_id, { session: e.session_id, text });
  }
  if (e.kind === "ui.permission_answered") pending.delete(p.request_id);
  if (e.kind === "sidecar.session_ended") for (const [k, v] of pending) if (v.session === e.session_id) pending.delete(k);
}

async function connect(peer, paired) {
  show("pair", false); show("live");
  $("mac").textContent = paired.mac;
  $("link").textContent = "connecting…";
  const t = performance.now();
  link = await peer.link(JSON.stringify(paired.addr), "", (json) => {
    const f = JSON.parse(json);
    if (f.t === "welcome") { pushKey = f.push_key; }
    else if (f.t === "events") { for (const e of f.events) onEvent(e); render(); }
    else if (f.t === "live") { $("link").textContent = "live"; $("link").className = "ok"; log(`caught up in ${Math.round(performance.now() - t)} ms`); render(); }
    else if (f.t === "ack") { $("notifyState").textContent = f.ok ? `Your Mac sent a test push (${f.result?.status ?? "?"}).` : `Your Mac said: ${f.error}`; }
    else if (f.t === "closed") { $("link").textContent = "offline"; $("link").className = "err"; log("link closed:", f.error); setTimeout(() => location.reload(), 5000); }
  });
}

async function turnOnNotifications() {
  if (!standalone) { $("notifyState").textContent = "Open Cockpit from your Home Screen first."; return; }
  if (!pushKey) { $("notifyState").textContent = "Your Mac's Cockpit doesn't send pushes yet: update it."; return; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { $("notifyState").textContent = `Notifications: ${perm}. Allow them in Settings → Notifications → Cockpit.`; return; }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(pushKey) });
  link.command(JSON.stringify({ kind: "register_push", args: { subscription: sub.toJSON() } }));
  $("notifyState").textContent = "Sent to your Mac…";
  log("push service:", new URL(sub.endpoint).host);
}

try {
  if ("serviceWorker" in navigator) await navigator.serviceWorker.register("sw.js");
  show("install", !standalone);
  await init({ module_or_path: new URL("./pkg/remote_web_bg.wasm?v=2", import.meta.url) });
  const peer = await WebPeer.create(localStorage.getItem("mr.remote.secret") ?? "");
  localStorage.setItem("mr.remote.secret", peer.secret());
  const paired = JSON.parse(localStorage.getItem("mr.remote.paired") ?? "null");
  $("notify").onclick = () => turnOnNotifications().catch((e) => { $("notifyState").textContent = String(e); });
  $("forget").onclick = () => { localStorage.clear(); location.reload(); };
  // A code in the link (the Mac's QR): the part after # never reaches the site.
  const fromLink = decodeURIComponent(location.hash.slice(1));
  if (fromLink) history.replaceState(null, "", location.pathname);
  const linkCode = fromLink.startsWith("cockpit-remote:") ? fromLink : "";
  if (paired) await connect(peer, paired);
  else if (linkCode && !standalone) {
    show("handoff");
    $("copy").onclick = async () => { await navigator.clipboard.writeText(linkCode); $("copy").textContent = "Copied: now open Cockpit from your Home Screen"; };
  } else {
    show("pair");
    $("paste").onclick = async () => { try { $("text").value = await navigator.clipboard.readText(); } catch (e) { log("paste:", e); } };
    if (linkCode) $("text").value = linkCode;
    $("go").onclick = async () => {
      $("go").disabled = true;
      try {
        const p = JSON.parse(await peer.pair($("text").value.trim(), standalone ? "iPhone (Home Screen)" : "iPhone (Safari)", (code) => {
          show("code"); $("digits").textContent = code.slice(0, 3) + " " + code.slice(3);
        }));
        localStorage.setItem("mr.remote.paired", JSON.stringify(p));
        await connect(peer, p);
      } catch (e) { log("pair:", e); $("go").disabled = false; }
    };
    if (linkCode) $("go").click();
  }
} catch (e) { log("error:", e); }
