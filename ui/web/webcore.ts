import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import init, { WebPeer, type WebLink } from "../../crates/remote-web/pkg/remote_web.js";
import type { MrEvent } from "../src/state/types";

// Cockpit Remote's web core (decision 46). Lives outside src/ with its own entry (ui/web), so the
// desktop and native builds never need the wasm package, which only scripts/build-remote-web.sh
// builds.
// the installable web app's stand-in for the native
// app's Rust core (mobile/src-tauri). It answers the same calls (`events_list`, `remote_pair`,
// `remote_command`, …) and emits the same events (`mr-event`, `mr-remote`), so MobileApp, the
// store and the desktop reducer run unchanged. Underneath is the wasm link (crates/remote-web):
// iroh over a relay, end to end encrypted to the one Mac this phone paired with.
//
// - Keeps no history: each open asks the Mac for "now" (light), then follows live rows.
// - A session's transcript is fetched when it's opened (`events_session`).
// - Reconnects with backoff, resuming after the newest row it has.
// - Face ID: a passkey made at pairing signs every allow, answer and start; the Mac checks it.

type Known = { workspaces: { id: string; name: string }[]; repos: { id: string; name: string }[] };
type Paired = { mac: string; addr: unknown };
type Frame = { t: string; [k: string]: unknown };
type Waiter<T> = { resolve: (v: T) => void; reject: (e: unknown) => void };

const KEY = "mr.remote.secret";
const PAIRED = "mr.remote.paired";
const CREDENTIAL = "mr.remote.passkey";

const status = { connected: false, live: false, error: null as string | null, known: { workspaces: [], repos: [] } as Known, pushKey: null as string | null, nonce: "", app: null as { version: string; root: string; sw?: string } | null, installed: null as string | null, loaderChanged: false };
const events: MrEvent[] = [];
const ids = new Set<string>();
const acks = new Map<string, Waiter<unknown>>();
const sessionReqs = new Map<string, Waiter<MrEvent[]>>();
const docReqs = new Map<string, Waiter<unknown[]>>();
const changeReqs = new Map<string, Waiter<{ files?: unknown; diff?: string }>>();
let docsCache: unknown[] = [];
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
      status.nonce = String(f.nonce ?? "");
      status.app = (f.app as { version: string; root: string; sw?: string } | null) ?? null;
      void checkVersion();
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
    case "changes": {
      const w = changeReqs.get(String(f.id));
      changeReqs.delete(String(f.id));
      if (f.error) w?.reject(String(f.error)); else w?.resolve({ files: f.files, diff: f.diff as string | undefined });
      break;
    }
    case "docs": {
      const w = docReqs.get(String(f.id));
      docReqs.delete(String(f.id));
      w?.resolve(f.docs as unknown[]);
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

// ---- Face ID (passkeys, decision 46) -------------------------------------------------------
// The web app's origin is the passkey's relying party. A local dev copy (localhost, 127.0.0.1)
// may pair without one; on the real site a passkey is required.
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const devHost = () => ["localhost", "127.0.0.1"].includes(location.hostname);

async function makePasskey(mac: string): Promise<string> {
  if (!window.PublicKeyCredential) {
    if (devHost()) return "";
    throw new Error("This browser can't make a passkey, which Cockpit Remote needs for Face ID.");
  }
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: "Cockpit Remote" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `Cockpit on ${mac}`, displayName: `Cockpit on ${mac}` },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        attestation: "none",
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
    const spki = (cred?.response as AuthenticatorAttestationResponse | undefined)?.getPublicKey?.();
    if (!cred || !spki) throw new Error("no public key");
    localStorage.setItem(CREDENTIAL, b64(cred.rawId));
    return JSON.stringify({ credential_id: b64(cred.rawId), public_key: b64(spki) });
  } catch (e) {
    if (devHost()) return "";
    throw new Error(`Face ID setup didn't finish (${e instanceof Error ? e.message : e}). Pair again to retry.`);
  }
}

const NEEDS_FACE_ID = (c: { kind: string; args: Record<string, unknown> }) =>
  (c.kind === "permission_response" && (c.args.decision as { behavior?: string })?.behavior === "allow") || c.kind === "answer_question" || c.kind === "start_session";

async function prove(json: string): Promise<string> {
  const id = localStorage.getItem(CREDENTIAL);
  if (!id) return "";
  const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${status.nonce}\n${json}`)));
  const raw = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (id.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const a = (await navigator.credentials.get({ publicKey: { challenge, rpId: location.hostname, allowCredentials: [{ type: "public-key", id: raw }], userVerification: "required", timeout: 60_000 } })) as PublicKeyCredential | null;
  if (!a) throw new Error("Face ID didn't confirm it; nothing was sent");
  const r = a.response as AuthenticatorAssertionResponse;
  return JSON.stringify({ json, credential_id: b64(a.rawId), authenticator_data: b64(r.authenticatorData), client_data_json: b64(r.clientDataJSON), signature: b64(r.signature) });
}

// ---- Pinned updates (decision 47) -----------------------------------------------------------
// The service worker (/remote/sw.js) serves only the version it installed and checked. Your
// Mac's Cockpit vouches for one version; when it differs, the app offers to update to exactly
// that root hash, and the service worker checks every file before swapping it in.
function askWorker<T>(msg: object, want: string, ms = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return reject(new Error("the app isn't installed yet: reopen it"));
    const t = setTimeout(() => { navigator.serviceWorker.removeEventListener("message", on); reject(new Error("timed out")); }, ms);
    const on = (e: MessageEvent) => {
      if (!e.data || !String(e.data.type).startsWith(want)) return;
      clearTimeout(t);
      navigator.serviceWorker.removeEventListener("message", on);
      resolve(e.data as T);
    };
    navigator.serviceWorker.addEventListener("message", on);
    sw.postMessage(msg);
  });
}

async function checkVersion() {
  // The loader is the one file a browser re-fetches by itself: compare it with what the Mac's
  // release shipped.
  if (status.app?.sw) {
    try {
      const body = await (await fetch("./sw.js", { cache: "no-store" })).arrayBuffer();
      const got = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((b) => b.toString(16).padStart(2, "0")).join("");
      status.loaderChanged = got !== status.app.sw;
    } catch { /* offline: nothing to compare */ }
  }
  try {
    const r = await askWorker<{ pinned: { version: string; root: string } | null }>({ type: "pinned" }, "pinned", 5_000);
    status.installed = r.pinned?.version ?? null;
  } catch { status.installed = null; }
  changed();
}

const updateAvailable = () => !!status.app && !!status.installed && status.app.version !== status.installed;

async function update(): Promise<string> {
  if (!status.app) throw new Error("your Mac didn't name a version");
  const r = await askWorker<{ type: string; error?: string }>({ type: "update", ...status.app }, "update");
  if (r.type !== "updated") throw new Error(`the update didn't check out (${r.error}); keeping this version`);
  setTimeout(() => location.reload(), 300);
  return "Updated: restarting…";
}

async function sendCommand(command: { kind: string; args: Record<string, unknown> }): Promise<unknown> {
  if (!link || !status.live) throw new Error("not connected to your Mac");
  const json = JSON.stringify(command);
  // Face ID before it leaves the phone; the Mac checks the signature too.
  const proof = NEEDS_FACE_ID(command) ? await prove(json) : "";
  if (!link) throw new Error("the link to your Mac dropped; try again");
  const id = String(++nextAck);
  const done = new Promise((resolve, reject) => acks.set(id, { resolve, reject }));
  link.command(json, proof);
  return Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("your Mac didn't answer in 30 s")), 30_000))]);
}

// Working docs live on the Mac (folded there); the desktop's useDocs asks for them on every doc
// row, so keep the last answer for when the link is down.
async function docsList(): Promise<unknown[]> {
  if (!link) return docsCache;
  const id = `d${++nextReq}`;
  const done = new Promise<unknown[]>((resolve, reject) => docReqs.set(id, { resolve, reject }));
  link.fetch_docs(id);
  docsCache = await Promise.race([done, new Promise<unknown[]>((_, reject) => setTimeout(() => reject(new Error("timed out")), 30_000))]);
  return docsCache;
}

// The desktop's change screens ask by folder; the phone names the session instead (the Mac maps it
// back to that session's own folder), found from the session's start row here.
function sessionFor(cwd: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "ui.session_requested" && (e.payload as { cwd?: string })?.cwd === cwd) return e.session_id;
  }
  return null;
}

async function changes(cwd: string, path: string): Promise<{ files?: unknown; diff?: string }> {
  const session = sessionFor(cwd);
  if (!session) throw new Error("no session for these changes");
  if (!link) throw new Error("not connected to your Mac");
  const id = `c${++nextReq}`;
  const done = new Promise<{ files?: unknown; diff?: string }>((resolve, reject) => changeReqs.set(id, { resolve, reject }));
  link.fetch_changes(id, session, path);
  return Promise.race([done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 30_000))]);
}

// The desktop's screens record the user's actions with event_append; the Mac accepts these from a
// phone (remote_link::proto::LOG_UI_KINDS). Others are desktop-only bookkeeping: skipped quietly.
const LOG_UI_KINDS = new Set(["ui.review_noted", "ui.review_unnoted", "ui.address_chosen", "ui.doc_note", "ui.doc_decision", "ui.doc_edit", "ui.diff_note", "ui.diff_notes_sent", "ui.changes_approved", "ui.session_renamed", "ui.session_archived", "ui.session_unarchived"]);

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
      return { paired: p ? { name: p.mac } : null, connected: status.connected, live: status.live, error: status.error, known: status.known, push: !!status.pushKey, web: true, standalone: standalone(), version: status.installed, update: updateAvailable() ? status.app?.version : null, loaderChanged: status.loaderChanged };
    }
    case "remote_pair": {
      const p = await getPeer();
      // Face ID first, while the tap that started pairing still counts as a user gesture.
      const passkey = await makePasskey("your Mac");
      const out = JSON.parse(await p.pair(String(a.text), String(a.name ?? "iPhone"), passkey, (code: string) => void emit("mr-remote-code", code))) as Paired;
      localStorage.setItem(PAIRED, JSON.stringify(out));
      events.length = 0;
      ids.clear();
      synced = deferred();
      changed();
      void connect();
      return out.mac;
    }
    case "remote_command": return sendCommand(a.command as { kind: string; args: Record<string, unknown> });
    // The desktop's own components (Flows, PlanPanel, CatalogView, AskRow, docs) call these.
    case "session_send": return sendCommand({ kind: "send_prompt", args: { session: String(a.session), text: String(a.text ?? "") } });
    case "permission_respond": return sendCommand({ kind: "permission_response", args: { session: String(a.session), request_id: String(a.requestId), decision: a.decision as Record<string, unknown> } });
    case "session_interrupt": return sendCommand({ kind: "interrupt", args: { session: String(a.session) } });
    case "session_stop": return sendCommand({ kind: "stop_session", args: { session: String(a.session) } });
    case "event_append": {
      const kind = String(a.kind);
      if (!LOG_UI_KINDS.has(kind)) return null;
      return sendCommand({ kind: "log_ui", args: { session: (a.sessionId as string) ?? null, kind, payload: (a.payload as Record<string, unknown>) ?? {}, anchor: (a.anchor as string) ?? null } });
    }
    case "docs_list": return docsList();
    case "session_changes": return (await changes(String(a.cwd), "")).files ?? [];
    case "session_diff": return (await changes(String(a.cwd), String(a.path))).diff ?? "";
    case "remote_doc_send": return sendCommand({ kind: "doc_send", args: { doc_id: String(a.docId), regenerate: !!a.regenerate } });
    case "remote_push_enable": return enablePush();
    case "remote_update": return update();
    case "remote_fetch": return null;
    case "remote_forget": {
      generation++;
      link?.close();
      link = null;
      localStorage.removeItem(PAIRED);
      localStorage.removeItem(KEY);
      localStorage.removeItem(CREDENTIAL);
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
