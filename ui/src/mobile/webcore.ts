import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import init, { WebPeer, type WebLink } from "../../../crates/remote-web/pkg/remote_web.js";
import type { MrEvent } from "../state/types";

// Cockpit Remote's web core (decision 46): the installable web app's stand-in for the native
// app's Rust core (mobile/src-tauri). It answers the same calls (`events_list`, `remote_pair`,
// `remote_command`, …) and emits the same events (`mr-event`, `mr-remote`), so MobileApp, the
// store and the desktop reducer run unchanged. Underneath is the wasm link (crates/remote-web):
// iroh over a relay, end to end encrypted to the one Mac this phone paired with.
//
// - Keeps no history: each open asks the Mac for "now" (light), then follows live rows.
// - A session's transcript is fetched when it's opened (`events_session`).
// - Reconnects with backoff, resuming after the newest row it has.

type Known = { workspaces: { id: string; name: string }[]; repos: { id: string; name: string }[] };
type Paired = { mac: string; addr: unknown };
type Frame = { t: string; [k: string]: unknown };
type Waiter<T> = { resolve: (v: T) => void; reject: (e: unknown) => void };

const KEY = "mr.remote.secret";
const PAIRED = "mr.remote.paired";

const status = { connected: false, live: false, error: null as string | null, known: { workspaces: [], repos: [] } as Known, pushKey: null as string | null };
const events: MrEvent[] = [];
const ids = new Set<string>();
const acks = new Map<string, Waiter<unknown>>();
const sessionReqs = new Map<string, Waiter<MrEvent[]>>();
let peer: Promise<WebPeer> | null = null;
let link: WebLink | null = null;
let nextAck = 0;
let nextReq = 0;
let synced: Waiter<void> & { done: Promise<void> };
let generation = 0;

function deferred(): Waiter<void> & { done: Promise<void> } {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const done = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { resolve, reject, done };
}
synced = deferred();

const paired = (): Paired | null => JSON.parse(localStorage.getItem(PAIRED) ?? "null");
const changed = () => void emit("mr-remote", null);

function getPeer(): Promise<WebPeer> {
  peer ??= (async () => {
    await init();
    const p = await WebPeer.create(localStorage.getItem(KEY) ?? "");
    localStorage.setItem(KEY, p.secret());
    return p;
  })();
  return peer;
}

function addEvents(list: MrEvent[], live: boolean) {
  for (const e of list) {
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    events.push(e);
    if (live) void emit("mr-event", e);
  }
}

function onFrame(gen: number, f: Frame) {
  if (gen !== generation) return; // a link we've already dropped
  switch (f.t) {
    case "welcome":
      status.known = f.known as Known;
      status.pushKey = (f.push_key as string) ?? null;
      changed();
      break;
    case "events":
      addEvents(f.events as MrEvent[], status.live);
      break;
    case "live":
      status.live = true;
      status.error = null;
      synced.resolve();
      changed();
      break;
    case "ack": {
      const w = acks.get(String(f.id));
      acks.delete(String(f.id));
      if (f.ok) w?.resolve(f.result ?? null); else w?.reject(String(f.error ?? "the Mac refused"));
      break;
    }
    case "session_rows": {
      const w = sessionReqs.get(String(f.id));
      sessionReqs.delete(String(f.id));
      w?.resolve(f.events as MrEvent[]);
      break;
    }
    case "error":
      status.error = String(f.error);
      changed();
      break;
    case "closed":
      drop(String(f.error ?? "closed"));
      break;
  }
}

function drop(why: string) {
  link = null;
  status.connected = false;
  status.live = false;
  status.error = why === "closed" ? null : why;
  for (const w of acks.values()) w.reject("the link to the Mac dropped; try again");
  acks.clear();
  for (const w of sessionReqs.values()) w.reject("the link to the Mac dropped");
  sessionReqs.clear();
  synced.resolve(); // never keep the first screen waiting on a dead link
  changed();
  retry();
}

let backoff = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
function retry() {
  if (retryTimer || !paired()) return;
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

async function connect() {
  const p = paired();
  if (!p || link) return;
  const gen = ++generation;
  try {
    const peerNow = await getPeer();
    const cursor = events.length ? events[events.length - 1].id : "";
    const l = await peerNow.link(JSON.stringify(p.addr), cursor, (json: string) => onFrame(gen, JSON.parse(json)));
    if (gen !== generation) { l.close(); return; }
    link = l;
    nextAck = 0;
    status.connected = true;
    backoff = 1000;
    changed();
  } catch (e) {
    if (gen === generation) drop(String(e));
  }
}

// iOS suspends a backgrounded web app; reopening it should reconnect at once.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !link && paired()) {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    backoff = 1000;
    void connect();
  }
});

async function sendCommand(command: unknown): Promise<unknown> {
  if (!link || !status.live) throw new Error("not connected to your Mac");
  const id = String(++nextAck);
  const done = new Promise((resolve, reject) => acks.set(id, { resolve, reject }));
  link.command(JSON.stringify(command));
  return Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("your Mac didn't answer in 30 s")), 30_000))]);
}

async function sessionRows(session: string): Promise<MrEvent[]> {
  if (!link) throw new Error("not connected");
  const id = `s${++nextReq}`;
  const done = new Promise<MrEvent[]>((resolve, reject) => sessionReqs.set(id, { resolve, reject }));
  link.fetch_session(id, session);
  const rows = await Promise.race([done, new Promise<MrEvent[]>((_, reject) => setTimeout(() => reject(new Error("timed out")), 30_000))]);
  // The store replays a session with the app-wide rows interleaved (as the Mac's session_wire).
  const appWide = events.filter((e) => e.session_id === null);
  const have = new Set(rows.map((e) => e.id));
  const mine = events.filter((e) => e.session_id === session && !have.has(e.id));
  return [...rows, ...appWide, ...mine].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export const standalone = () => (navigator as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;

async function enablePush(): Promise<string> {
  if (!standalone()) throw new Error("Open Cockpit from your Home Screen first: iPhone only notifies Home Screen apps.");
  if (!status.pushKey) throw new Error("Your Mac's Cockpit doesn't send notifications yet: update it.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(`Notifications are ${perm}. Allow them in Settings → Notifications → Cockpit.`);
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(status.pushKey) }));
  await sendCommand({ kind: "register_push", args: { subscription: sub.toJSON() } });
  return "On: your Mac sent a test notification.";
}

async function handle(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "instance_id": throw new Error("phone");
    case "events_list": {
      await Promise.race([synced.done, new Promise((r) => setTimeout(r, 15_000))]);
      const after = (a.after as string | null) ?? "";
      const limit = Number(a.limit ?? 5000);
      return events.filter((e) => e.id > after).sort((x, y) => (x.id < y.id ? -1 : 1)).slice(0, limit);
    }
    case "events_session": return sessionRows(String(a.sessionId));
    case "remote_state": {
      const p = paired();
      return { paired: p ? { name: p.mac } : null, connected: status.connected, live: status.live, error: status.error, known: status.known, push: !!status.pushKey, web: true, standalone: standalone() };
    }
    case "remote_pair": {
      const p = await getPeer();
      const out = JSON.parse(await p.pair(String(a.text), String(a.name ?? "iPhone"), (code: string) => void emit("mr-remote-code", code))) as Paired;
      localStorage.setItem(PAIRED, JSON.stringify(out));
      events.length = 0;
      ids.clear();
      synced = deferred();
      changed();
      void connect();
      return out.mac;
    }
    case "remote_command": return sendCommand(a.command);
    case "remote_push_enable": return enablePush();
    case "remote_fetch": return null;
    case "remote_forget": {
      generation++;
      link?.close();
      link = null;
      localStorage.removeItem(PAIRED);
      localStorage.removeItem(KEY);
      peer = null;
      events.length = 0;
      ids.clear();
      Object.assign(status, { connected: false, live: false, error: null, pushKey: null });
      const sub = await navigator.serviceWorker?.ready.then((r) => r.pushManager.getSubscription()).catch(() => null);
      await sub?.unsubscribe();
      changed();
      return null;
    }
    default: return null;
  }
}

/** Installs the web core under the Tauri API, then connects if this phone is paired. */
export function install() {
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Record<string, unknown>), { shouldMockEvents: true });
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("./sw.js");
  if (paired()) void connect();
  else synced.resolve();
}
