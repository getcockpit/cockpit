import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "../state/listen";
import { hydrate, useAppState } from "../state/store";
import { pickTile } from "../picker/pick";
import { sessionTitle } from "../picker/title";
import { LABEL } from "../components";
import { shortError } from "../components/ErrorLine";
import type { PendingAsk, SessionState } from "../state/types";
import * as cmd from "./commands";
import { pickWorkspace, workspaceChips } from "./workspaces";
import { api } from "../state/store";
import { Transcript } from "../screens/Focus";
import { ReviewChanges } from "../screens/ReviewChanges";
import { AddressView, ReviewView } from "../screens/Flows";
import { PlanPanel } from "../components/PlanPanel";
import { CatalogView } from "../components/CatalogView";
import { Markdown } from "../components/Markdown";
import { promptFor } from "../screens/StartPicker";
import { blockView, docApi, docsOf, isOpenQuestion, orderedBlocks, SECTION_LABEL, useDocs, type Doc } from "../state/docs";

// Cockpit Remote on the iPhone (doc "Cockpit Remote", phases 2 and 4). The Mac is the brain: the
// mobile core (mobile/src-tauri) mirrors its event log, and the desktop's own store and reducer
// replay it here. Screens: Pair (first run), Wall (needs-you first, Start), Focus (one session:
// allow/deny, answers, reply, interrupt). Nothing changes here until the Mac's own rows come back.

type Known = { workspaces: { id: string; name: string }[]; repos: { id: string; name: string }[] };
// web / standalone / push: only the web app's core sets them (decision 46).
type RemoteState = { paired: { name: string } | null; connected: boolean; live: boolean; error: string | null; known: Known; web?: boolean; standalone?: boolean; push?: boolean; version?: string | null; update?: string | null; loaderChanged?: boolean };

// Decision 47: the app changes only to the version your Mac's Cockpit vouches for, on your OK.
function UpdateBanner({ remote }: { remote: RemoteState }) {
  const [msg, setMsg] = useState("");
  if (remote.loaderChanged) {
    return (
      <div data-mr="MobileLoaderChanged" className="mm-note" style={{ borderLeft: "4px solid var(--mr-error)" }}>
        <b>The app's loader on the site changed without a matching Cockpit release on your Mac.</b> If you didn't just update Cockpit, don't approve anything from this phone, and check the Mac.
      </div>
    );
  }
  if (!remote.update) return null;
  return (
    <div data-mr="MobileUpdate" className="mm-note">
      <b>Update from your Mac.</b> Your Mac's Cockpit vouches for app version {remote.update} (this is {remote.version}). It's checked file by file before it runs.{" "}
      <button type="button" className="mr-key" onClick={() => void invoke<string>("remote_update").then(setMsg, (e) => setMsg(shortError(e)))}>Update</button>
      {msg && <span className="mm-dim"> {msg}</span>}
    </div>
  );
}

// The web app only notifies, and keeps its pairing, when opened from the Home Screen.
function InstallHint({ remote }: { remote: RemoteState }) {
  if (!remote.web || remote.standalone) return null;
  return (
    <div data-mr="MobileInstall" className="mm-note">
      <b>Add Cockpit to your Home Screen.</b> Tap Share → Add to Home Screen, keep "Open as Web App" on, then open it from there. iPhone only sends notifications to Home Screen apps.
    </div>
  );
}

// A code that came in the link (the Mac's QR): after the #, so it never reaches the site.
const linkCode = (() => {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("cockpit-remote:")) history.replaceState(null, "", location.pathname + location.search);
  return h.startsWith("cockpit-remote:") ? h : "";
})();

function useRemote() {
  const [st, setSt] = useState<RemoteState | null>(null);
  const load = useCallback(() => { invoke<RemoteState>("remote_state").then(setSt, () => {}); }, []);
  useEffect(() => {
    load();
    const un = listen("mr-remote", load);
    return () => { un.then((f) => f()); };
  }, [load]);
  return [st, load] as const;
}

export function MobileApp() {
  const [remote, reload] = useRemote();
  if (!remote) return null;
  if (!remote.paired) return <Pair remote={remote} onDone={reload} linkError={remote.error} />;
  return <Paired remote={remote} />;
}

function Pair({ remote, onDone, linkError }: { remote: RemoteState; onDone: () => void; linkError: string | null }) {
  const [text, setText] = useState(linkCode);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const un = listen<string>("mr-remote-code", ({ payload }) => setCode(payload));
    return () => { un.then((f) => f()); };
  }, []);
  const pair = async () => {
    setBusy(true); setMsg(""); setCode(null);
    try { await invoke("remote_pair", { text: text.trim(), name: "iPhone" }); onDone(); }
    catch (e) { setMsg(shortError(e)); }
    finally { setBusy(false); }
  };
  return (
    <main data-mr="MobilePair" className="mm-screen mm-pad">
      <InstallHint remote={remote} />
      <h1 className="mm-title">Pair with your Mac</h1>
      <p className="mm-dim">On the Mac: Cockpit → Settings → Remote → Pair a phone. Scan its code with the camera, or tap Copy as text there and Paste here. Pairing happens once, in person; only this phone and that Mac can ever talk.</p>
      {remote.web && <button type="button" className="mr-key mm-wide" data-mr="MobilePaste" onClick={() => void navigator.clipboard.readText().then(setText).catch(() => {})}>Paste from Mac</button>}
      <textarea data-mr="MobilePairText" className="mm-input" rows={4} placeholder="cockpit-remote:1:…" value={text} onChange={(e) => setText(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button type="button" className="mr-key mm-wide" data-tone="primary" disabled={busy || !text.trim().startsWith("cockpit-remote:")} onClick={() => void pair()}>{busy ? (code ? "Confirm on the Mac…" : "Reaching the Mac…") : "Pair"}</button>
      {code && (
        <div data-mr="MobilePairCode" className="mm-code">
          <span className="mm-dim">The Mac should show the same code. Confirm it there.</span>
          <b>{code.slice(0, 3)} {code.slice(3)}</b>
        </div>
      )}
      {(msg || linkError) && <p className="mm-error">{msg || linkError}</p>}
    </main>
  );
}

// Needs you first, then working, then the rest by last activity.
const RANK: Record<string, number> = { needs_you: 0, error: 1, review: 2, almost: 3, working: 3, starting: 3, idle: 4, interrupted: 5, done: 6 };
const lastAt = (s: SessionState) => s.transcript.at(-1)?.at ?? 0;

function Paired({ remote }: { remote: RemoteState }) {
  const state = useAppState();
  // A notification tap opens its session: ?session= on launch, or a message from the service worker.
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(location.search).get("session"));
  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (e.data?.open) setOpen(String(e.data.open)); };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, []);
  const [menu, setMenu] = useState(false);
  const [starting, setStarting] = useState(false);
  // Working docs live on the Mac; the desktop's hook refetches them whenever a doc row lands.
  const docs = useDocs() ?? [];
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const doc = openDoc ? docs.find((d) => d.id === openDoc) ?? null : null;
  // The workspace on show, remembered on this phone; a deleted one falls back to All.
  const [chosenWs, setChosenWs] = useState<string | null>(() => localStorage.getItem("mr.remote.workspace"));
  const ws = pickWorkspace(chosenWs, state.workspaces);
  const chooseWs = (id: string) => { setChosenWs(id); localStorage.setItem("mr.remote.workspace", id); };
  const allRows = useMemo(() => Object.values(state.sessions)
    .filter((s) => !s.archivedAt)
    .map((s) => ({ s, tile: pickTile(s) }))
    .sort((a, b) => (RANK[a.tile.state] ?? 9) - (RANK[b.tile.state] ?? 9) || lastAt(b.s) - lastAt(a.s)), [state.sessions]);
  const chips = workspaceChips(state.workspaces, allRows.map((r) => ({ s: r.s, needs: r.tile.state === "needs_you" })));
  const rows = ws === "all" ? allRows : allRows.filter((r) => r.s.workspace === ws);
  const session = open && !doc ? state.sessions[open] : null;
  // Docs waiting on your answers, for the sessions on show.
  const shown = new Set(rows.map((r) => r.s.id));
  // Docs whose session isn't known here (archived, or synced light) still show; a known session
  // in another workspace hides its doc with it.
  const askingDocs = docs.filter((d) => (!d.session_id || shown.has(d.session_id) || !state.sessions[d.session_id]) && orderedBlocks(d).some(isOpenQuestion));
  const needs = rows.filter((r) => r.tile.state === "needs_you").length;
  const lamp = remote.connected ? (remote.live ? "live" : "sync") : "off";

  return (
    <div className="mm-screen">
      <header className="mm-band" data-mr="MobileBar">
        {doc ? <button type="button" className="mr-key" onClick={() => setOpenDoc(null)}>‹ Back</button> : session ? <button type="button" className="mr-key" onClick={() => setOpen(null)}>‹ Wall</button> : <strong className="mm-grow">{remote.paired?.name}</strong>}
        {(session || doc) && <span className="mm-grow" />}
        <span data-mr="MobileLink" data-mr-source={lamp} className="mm-link" data-on={lamp}>
          {remote.connected ? (remote.live ? "Live" : "Catching up…") : remote.error ? "Mac unreachable" : "Connecting…"}
        </span>
        {!session && !doc && <button type="button" className="mr-key" data-mr="MobileStartOpen" onClick={() => { setMenu(false); setStarting(!starting); }}>＋</button>}
        {!session && !doc && <button type="button" className="mr-key" aria-label="Menu" onClick={() => { setStarting(false); setMenu(!menu); }}>⋯</button>}
      </header>
      {!session && <InstallHint remote={remote} />}
      {!session && <UpdateBanner remote={remote} />}
      {menu && !session && <Menu remote={remote} usage={state.usage} onClose={() => setMenu(false)} />}
      {starting && !session && <Start known={remote.known} live={remote.connected} workspace={ws === "all" ? null : ws} onClose={() => setStarting(false)} onStarted={(id) => { setStarting(false); setOpen(id); }} />}
      {!remote.connected && remote.error && <p className="mm-note">{remote.error}. Showing what this phone last saw; it retries by itself.</p>}
      {doc ? <DocReader d={doc} live={remote.connected} /> : session ? <Focus s={session} live={remote.connected} docs={docs} onOpenDoc={setOpenDoc} onClosed={() => setOpen(null)} /> : (
        <main data-mr="MobileWall" className="mm-list">
          {state.workspaces.length > 1 && (
            <nav data-mr="MobileWorkspaces" className="mm-ws" aria-label="Workspaces">
              {chips.map((c) => (
                <button key={c.id} type="button" className="mm-chip" data-mr="MobileWorkspace" data-mr-source={c.id} aria-pressed={ws === c.id} onClick={() => chooseWs(c.id)}>
                  {c.name}
                  {c.needs > 0 ? <span className="mm-count" data-on="needs">{c.needs}</span> : <span className="mm-count">{c.sessions}</span>}
                </button>
              ))}
            </nav>
          )}
          {!state.loaded ? <p className="mm-dim mm-pad">Loading…</p> : rows.length === 0 ? <p className="mm-dim mm-pad">{ws === "all" ? "No sessions on the Mac yet." : `No sessions in ${chips.find((c) => c.id === ws)?.name ?? "this workspace"}.`}</p> : (
            <>
              {needs > 0 && <p className="mm-section" data-on="needs">{needs} need{needs === 1 ? "s" : ""} you</p>}
              {askingDocs.map((d) => (
                <button key={d.id} type="button" className="mm-row" data-mr="MobileDocAsks" data-mr-source={d.id} data-state="needs_you" onClick={() => setOpenDoc(d.id)}>
                  <span className="mm-lamp" data-state="needs_you" />
                  <span className="mm-grow mm-col"><b className="mm-clip">▤ {d.title}</b><span className="mm-dim">{orderedBlocks(d).filter(isOpenQuestion).length} question(s) for you</span></span>
                </button>
              ))}
              {rows.map(({ s, tile }) => (
                <button key={s.id} type="button" className="mm-row" data-mr="MobileTile" data-mr-source={s.id} data-state={tile.state} onClick={() => setOpen(s.id)}>
                  <span className="mm-lamp" data-state={tile.state} />
                  <span className="mm-grow mm-col">
                    <b className="mm-clip">{sessionTitle(s)}</b>
                    <span className="mm-dim mm-clip">{LABEL[tile.state]}{tile.doing && (tile.doing !== "Starting…" || tile.state === "starting") ? ` · ${tile.doing}` : ""}{tile.progressLabel ? ` · ${tile.progressLabel}` : ""}</span>
                    {tile.progress != null && <span className="mm-progress" aria-label={tile.progressLabel}><span style={{ width: `${Math.round(tile.progress * 100)}%` }} /></span>}
                  </span>
                </button>
              ))}
            </>
          )}
        </main>
      )}
    </div>
  );
}

function Menu({ remote, onClose, usage }: { remote: RemoteState; onClose: () => void; usage?: { fiveHour: number | null; weekly: number | null } }) {
  const [msg, setMsg] = useState("");
  const forget = async () => {
    if (!confirm(`Forget ${remote.paired?.name}? This phone's copy of its sessions is wiped, and pairing again needs the Mac.`)) return;
    try { await invoke("remote_forget"); onClose(); } catch (e) { setMsg(shortError(e)); }
  };
  return (
    <div data-mr="MobileMenu" className="mm-sheet mm-pad">
      <span className="mm-dim">Paired with {remote.paired?.name}. Everything travels end to end encrypted, straight between this phone and the Mac.{remote.version ? ` App version ${remote.version}, checked against your Mac's Cockpit.` : ""}</span>
      {usage && (usage.fiveHour != null || usage.weekly != null) && (
        <span data-mr="MobileUsage">Claude usage: {usage.fiveHour != null ? `${Math.round(usage.fiveHour * 100)}% of 5 hours` : ""}{usage.fiveHour != null && usage.weekly != null ? " · " : ""}{usage.weekly != null ? `${Math.round(usage.weekly * 100)}% of the week` : ""}</span>
      )}
      {remote.web && <button type="button" className="mr-key mm-wide" data-tone="primary" data-mr="MobileNotify" onClick={() => void invoke<string>("remote_push_enable").then(setMsg, (e) => setMsg(shortError(e)))}>Turn on notifications</button>}
      <button type="button" className="mr-key mm-wide" onClick={() => void forget()}>Forget this Mac</button>
      {msg && <p className="mm-error">{msg}</p>}
    </div>
  );
}

// Sends one command and keeps its state: busy while the Mac hasn't acked, the error if it refused
// (or Face ID didn't confirm). The result shows up as the Mac's own rows, never optimistically.
function useSend() {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const run = async (key: string, c: cmd.Command) => {
    setBusy(key); setErr("");
    try { return await cmd.send<{ session?: string } | null>(c); }
    catch (e) { setErr(shortError(e)); return undefined; }
    finally { setBusy(null); }
  };
  return { busy, err, run };
}

function Focus({ s, live, docs, onOpenDoc, onClosed }: { s: SessionState; live: boolean; docs: Doc[]; onOpenDoc: (id: string) => void; onClosed: () => void }) {
  const tile = pickTile(s);
  const { busy, err, run } = useSend();
  const [actions, setActions] = useState(false);
  // The desktop's change review (files, diffs, line notes, "looks good → PR"), fetched from the
  // session's own folder on the Mac.
  const [changes, setChanges] = useState(false);
  // The light sync carries no transcripts: fetch this session's when it opens.
  useEffect(() => { hydrate(s.id); window.scrollTo(0, document.body.scrollHeight); }, [s.id]);
  // The transcript arrives after opening: land at its end then, where the asks are (as the
  // desktop's Focus does); a new question scrolls into view.
  const loaded = s.transcript.length > 0;
  useEffect(() => { if (loaded) window.scrollTo(0, document.body.scrollHeight); }, [s.id, loaded]);
  const asks = s.pending.map((a) => a.requestId).join(",");
  useEffect(() => { if (asks) document.querySelector("[data-mr=MobileAsk]")?.scrollIntoView({ block: "center" }); }, [asks]);
  const working = ["working", "starting", "almost"].includes(tile.state);
  const reply = (text: string) => void api.send(s.id, text).catch(() => {});
  const mine = docsOf(docs, s.id);
  return (
    <main data-mr="MobileFocus" data-mr-source={s.id} className="mm-col mm-focus">
      <div className="mm-pad mm-col" style={{ gap: 4 }}>
        <b>{sessionTitle(s)}</b>
        <span className="mm-row-flat">
          <span className="mm-dim mm-grow"><span className="mm-lamp" data-state={tile.state} /> {LABEL[tile.state]}{tile.progressLabel ? ` · ${tile.progressLabel}` : ""}</span>
          {working && <button type="button" className="mr-key" data-mr="MobileInterrupt" disabled={!live || !!busy} onClick={() => void run("interrupt", cmd.interrupt(s.id))}>{busy === "interrupt" ? "Stopping…" : "Interrupt"}</button>}
          {Object.keys(s.files).length > 0 && <button type="button" className="mr-key" data-mr="MobileChanges" onClick={() => setChanges(!changes)}>{changes ? "Transcript" : `Changes · ${Object.keys(s.files).length}`}</button>}
          <button type="button" className="mr-key" aria-label="Session actions" data-mr="MobileSessionActions" onClick={() => setActions(!actions)}>⋯</button>
        </span>
      </div>
      {actions && <SessionActions s={s} live={live} onClosed={onClosed} />}
      {s.todos.length > 0 && <div className="mm-desk"><PlanPanel s={s} /></div>}
      {mine.map((d) => {
        const open = orderedBlocks(d).filter(isOpenQuestion).length;
        return (
          <button key={d.id} type="button" className="mm-row" data-mr="MobileDoc" data-mr-source={d.id} data-state={open ? "needs_you" : undefined} onClick={() => onOpenDoc(d.id)}>
            <span className="mm-grow mm-col"><b className="mm-clip">▤ {d.title}</b><span className="mm-dim">{open ? `${open} question(s) for you` : `Working doc · v${d.version}`}</span></span>
          </button>
        );
      })}
      <div className="mm-desk">
        {changes ? <ReviewChanges s={s} start={Object.keys(s.files)[0] ?? ""} onClose={() => setChanges(false)} /> : s.review ? <ReviewView s={s} /> : s.address ? <AddressView s={s} /> : (
          <Transcript items={s.transcript} commands={s.commands} plan={s.todos} running={working} raw={false} diagrams={s.diagrams} onDiscover={(what) => reply(`Tell me more about ${what}. Don't change anything.`)} onReply={reply} live={live && !working} />
        )}
      </div>
      {/* What waits on you, at the end where Focus lands (not above a long transcript). */}
      {s.pending.map((a) => <Ask key={a.requestId} s={s} a={a} live={live} />)}
      {err && <p className="mm-error mm-pad">{err}</p>}
      <Composer s={s} live={live} />
    </main>
  );
}

// Rename and archive, as the desktop's session menu does (the same ui.* rows).
function SessionActions({ s, live, onClosed }: { s: SessionState; live: boolean; onClosed: () => void }) {
  const [msg, setMsg] = useState("");
  const rename = async () => {
    const name = prompt("Name this session", sessionTitle(s));
    if (name == null) return;
    try { await api.log("ui.session_renamed", { name: name.trim() }, s.id); } catch (e) { setMsg(shortError(e)); }
  };
  const archive = async () => {
    if (!confirm("Mark it done? It leaves the Wall and stops if it's running.")) return;
    try { await api.log("ui.session_archived", { by: "phone" }, s.id); onClosed(); } catch (e) { setMsg(shortError(e)); }
  };
  return (
    <div data-mr="MobileSessionMenu" className="mm-sheet mm-pad">
      <button type="button" className="mr-key mm-wide" disabled={!live} onClick={() => void rename()}>Rename</button>
      <button type="button" className="mr-key mm-wide" disabled={!live} onClick={() => void archive()}>Done · archive</button>
      {msg && <p className="mm-error">{msg}</p>}
    </div>
  );
}

// A working doc on the phone: its blocks in order with their views, your answers to its
// questions, notes, and Send (the desktop's doc actions: the same ui.doc_* rows and doc_feedback).
function DocReader({ d, live }: { d: Doc; live: boolean }) {
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [body, setBody] = useState<Record<string, boolean>>({});
  const pending = d.pending_notes.length + d.pending_changes.length;
  const act = async (f: () => Promise<unknown>, done = "") => { setMsg(""); try { await f(); setMsg(done); } catch (e) { setMsg(shortError(e)); } };
  return (
    <main data-mr="MobileDocReader" data-mr-source={d.id} className="mm-col mm-focus">
      <div className="mm-pad mm-col" style={{ gap: 4 }}>
        <b>▤ {d.title}</b>
        <span className="mm-dim">Working doc · v{d.version}{pending ? ` · ${pending} change(s) not sent yet` : ""}</span>
        {pending > 0 && <button type="button" className="mr-key mm-wide" data-tone="primary" data-mr="MobileDocSend" disabled={!live} onClick={() => void act(() => invoke("remote_doc_send", { docId: d.id, regenerate: true }), "Sent: Claude is updating the doc.")}>Send to Claude</button>}
        {msg && <span className="mm-dim">{msg}</span>}
      </div>
      {orderedBlocks(d).map((b) => {
        const opts = b.data?.options ?? [];
        const multi = !!b.data?.multiSelect;
        const chosen = picks[b.id] ?? [];
        return (
          <section key={b.id} className="mm-block" data-mr="MobileDocBlock" data-mr-source={b.id} data-open={isOpenQuestion(b) || undefined}>
            <span className="mm-dim mm-mono">{SECTION_LABEL[b.section] ?? b.section}</span>
            <b>{b.takeaway}</b>
            {b.key && <span className="mm-dim">{b.key}</span>}
            {blockView(b).length > 0 && <div className="mm-desk"><CatalogView id={b.id} title="" blocks={blockView(b)} onReply={(t) => void act(() => docApi.note(d, b.id, t), "Noted.")} live={false} /></div>}
            {b.body && (body[b.id] ? <div className="mm-text"><Markdown text={b.body} /></div> : <button type="button" className="mr-key" onClick={() => setBody((x) => ({ ...x, [b.id]: true }))}>Read more</button>)}
            {b.section === "question" && (b.decision ? <span className="mm-ok">Decided: {b.decision}</span> : (
              <div className="mm-col" style={{ gap: 6 }}>
                {opts.map((o) => (
                  <button key={o.label} type="button" className="mm-option" aria-pressed={chosen.includes(o.label)} disabled={!live}
                    onClick={() => multi ? setPicks((p) => ({ ...p, [b.id]: chosen.includes(o.label) ? chosen.filter((x) => x !== o.label) : [...chosen, o.label] })) : void act(() => docApi.decide(d, b.id, o.label), "Decided. Send to Claude when you're done.")}>
                    <b>{o.label}</b>{o.description && <span className="mm-dim">{o.description}</span>}
                  </button>
                ))}
                {multi && <button type="button" className="mr-key" data-tone="needs" disabled={!live || !chosen.length} onClick={() => void act(() => docApi.decide(d, b.id, chosen.join(", ")), "Decided.")}>Decide</button>}
              </div>
            ))}
            <form className="mm-row-flat" onSubmit={(e) => { e.preventDefault(); const t = (notes[b.id] ?? "").trim(); if (t) void act(() => docApi.note(d, b.id, t), "Noted.").then(() => setNotes((x) => ({ ...x, [b.id]: "" }))); }}>
              <input className="mm-input mm-grow" placeholder="Note on this block…" value={notes[b.id] ?? ""} onChange={(e) => setNotes((x) => ({ ...x, [b.id]: e.target.value }))} disabled={!live} />
              <button type="submit" className="mr-key" disabled={!live || !(notes[b.id] ?? "").trim()}>Note</button>
            </form>
          </section>
        );
      })}
    </main>
  );
}

function Ask({ s, a, live }: { s: SessionState; a: PendingAsk; live: boolean }) {
  const { busy, err, run } = useSend();
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const pick = (q: string, label: string, multi?: boolean) =>
    setPicks((p) => ({ ...p, [q]: multi ? ((p[q] ?? []).includes(label) ? (p[q] ?? []).filter((x) => x !== label) : [...(p[q] ?? []), label]) : [label] }));
  const off = !live || !!busy;
  return (
    <div data-mr="MobileAsk" data-mr-source={a.requestId} className="mm-ask">
      {a.kind === "permission" ? (
        <>
          <b>Allow {a.tool}?</b>
          <span className="mm-clip3">{summarize(a.input) || a.tool}</span>
          {a.reason && <span className="mm-dim">{a.reason}</span>}
          <span className="mm-row-flat">
            <button type="button" className="mr-key mm-grow" data-tone="needs" data-mr="MobileAllow" disabled={off} onClick={() => void run("allow", cmd.allow(s.id, a))}>{busy === "allow" ? "Confirming…" : "Allow · Face ID"}</button>
            <button type="button" className="mr-key mm-grow" data-mr="MobileDeny" disabled={off} onClick={() => void run("deny", cmd.deny(s.id, a))}>{busy === "deny" ? "Denying…" : "Deny"}</button>
          </span>
        </>
      ) : (
        <>
          <b>Claude asks</b>
          {a.questions.map((q) => (
            <div key={q.question} className="mm-col" style={{ gap: 6 }}>
              <span>{q.question}{q.multiSelect ? <span className="mm-dim"> · pick any</span> : null}</span>
              {q.options.map((o) => (
                <button key={o.label} type="button" className="mm-option" data-mr="MobileOption" aria-pressed={(picks[q.question] ?? []).includes(o.label)} disabled={off} onClick={() => pick(q.question, o.label, q.multiSelect)}>
                  <b>{o.label}</b>{o.description && <span className="mm-dim">{o.description}</span>}
                </button>
              ))}
            </div>
          ))}
          <span className="mm-row-flat">
            <button type="button" className="mr-key mm-grow" data-tone="needs" data-mr="MobileAnswer" disabled={off || !cmd.answered(a, picks)} onClick={() => void run("answer", cmd.answer(s.id, a, picks))}>{busy === "answer" ? "Confirming…" : "Send answer · Face ID"}</button>
            <button type="button" className="mr-key" disabled={off} onClick={() => void run("deny", cmd.deny(s.id, a, "None of these fit. Ask me again on the Mac."))}>None fit</button>
          </span>
        </>
      )}
      {err && <span className="mm-error">{err}</span>}
    </div>
  );
}

function Composer({ s, live }: { s: SessionState; live: boolean }) {
  const [text, setText] = useState("");
  const { busy, err, run } = useSend();
  const submit = async () => {
    if (!text.trim()) return;
    if ((await run("reply", cmd.reply(s.id, text))) !== undefined) setText("");
  };
  return (
    <form data-mr="MobileComposer" className="mm-composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <textarea className="mm-input mm-grow" rows={2} placeholder={live ? "Reply to Claude…" : "Waiting for the Mac…"} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="mr-key" data-tone="primary" disabled={!live || !text.trim() || !!busy}>{busy ? "…" : "Send"}</button>
      {err && <span className="mm-error mm-full">{err}</span>}
    </form>
  );
}

// Start a session from the phone: a workspace and a repo the Mac already knows (ids only; the Mac
// maps them to its paths), plus the first prompt. Face ID first; 5 an hour (the Mac counts).
function Start({ known, live, workspace, onClose, onStarted }: { known: Known; live: boolean; workspace: string | null; onClose: () => void; onStarted: (id: string) => void }) {
  // The workspace on show on the Wall, if the Mac knows it.
  const [ws, setWs] = useState(known.workspaces.find((w) => w.id === workspace)?.id ?? known.workspaces[0]?.id ?? "");
  const [repo, setRepo] = useState(known.repos[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  // The desktop Start picker's kinds; Review and Address take a PR and run your own commands.
  const [kind, setKind] = useState<"blank" | "plan" | "review" | "address">("blank");
  const { busy, err, run } = useSend();
  const go = async () => {
    const r = await run("start", cmd.start(ws, repo, promptFor(kind, prompt), kind));
    if (r !== undefined) { if (r?.session) onStarted(r.session); else onClose(); }
  };
  if (!known.repos.length) return <div data-mr="MobileStart" className="mm-sheet mm-pad"><span className="mm-dim">No repos yet: start a session on the Mac once, and its repo shows up here.</span></div>;
  return (
    <div data-mr="MobileStart" className="mm-sheet mm-pad">
      <b>New session on the Mac</b>
      <label className="mm-col" style={{ gap: 4 }}><span className="mm-dim">Repo</span>
        <select className="mm-input" value={repo} onChange={(e) => setRepo(e.target.value)}>{known.repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      </label>
      {known.workspaces.length > 1 && (
        <label className="mm-col" style={{ gap: 4 }}><span className="mm-dim">Workspace</span>
          <select className="mm-input" value={ws} onChange={(e) => setWs(e.target.value)}>{known.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </label>
      )}
      <div className="mm-ws" role="radiogroup" aria-label="Kind" data-mr="MobileStartKind">
        {([["blank", "Task"], ["plan", "Plan"], ["review", "Review PR"], ["address", "Address PR"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="radio" className="mm-chip" aria-pressed={kind === k} aria-checked={kind === k} onClick={() => setKind(k)}>{label}</button>
        ))}
      </div>
      {kind === "review" || kind === "address"
        ? <input className="mm-input" placeholder="PR number or link" value={prompt} onChange={(e) => setPrompt(e.target.value)} autoCapitalize="off" />
        : <textarea className="mm-input" rows={3} placeholder={kind === "plan" ? "What should we plan?" : "What should Claude do?"} value={prompt} onChange={(e) => setPrompt(e.target.value)} />}
      <span className="mm-row-flat">
        <button type="button" className="mr-key mm-grow" data-tone="primary" data-mr="MobileStartGo" disabled={!live || !prompt.trim() || !repo || !!busy} onClick={() => void go()}>{busy ? "Starting…" : "Start · Face ID"}</button>
        <button type="button" className="mr-key" onClick={onClose}>Cancel</button>
      </span>
      <span className="mm-dim">It gets its own worktree, like a Start on the Mac, and asks you before running anything.</span>
      {err && <span className="mm-error">{err}</span>}
    </div>
  );
}

// The one argument worth a line on a phone; tools without one (TodoWrite, MCP calls) show their name only.
function summarize(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.query ?? input.description;
  return typeof v === "string" ? v.slice(0, 240) : "";
}

