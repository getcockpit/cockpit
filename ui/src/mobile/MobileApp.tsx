import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "../state/listen";
import { useAppState } from "../state/store";
import { pickTile } from "../picker/pick";
import { sessionTitle } from "../picker/title";
import { LABEL } from "../components";
import { shortError } from "../components/ErrorLine";
import type { PendingAsk, SessionState, TranscriptItem } from "../state/types";
import * as cmd from "./commands";

// Cockpit Remote on the iPhone (doc "Cockpit Remote", phases 2 and 4). The Mac is the brain: the
// mobile core (mobile/src-tauri) mirrors its event log, and the desktop's own store and reducer
// replay it here. Screens: Pair (first run), Wall (needs-you first, Start), Focus (one session:
// allow/deny, answers, reply, interrupt). Nothing changes here until the Mac's own rows come back.

type Known = { workspaces: { id: string; name: string }[]; repos: { id: string; name: string }[] };
type RemoteState = { paired: { name: string } | null; connected: boolean; live: boolean; error: string | null; known: Known };

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
  if (!remote.paired) return <Pair onDone={reload} linkError={remote.error} />;
  return <Paired remote={remote} />;
}

function Pair({ onDone, linkError }: { onDone: () => void; linkError: string | null }) {
  const [text, setText] = useState("");
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
      <h1 className="mm-title">Pair with your Mac</h1>
      <p className="mm-dim">On the Mac: Cockpit → Settings → Remote → Pair a phone. Then paste the pairing text here (Copy as text on the Mac). Pairing happens once, in person; only this phone and that Mac can ever talk.</p>
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
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [starting, setStarting] = useState(false);
  const rows = useMemo(() => Object.values(state.sessions)
    .filter((s) => !s.archivedAt)
    .map((s) => ({ s, tile: pickTile(s) }))
    .sort((a, b) => (RANK[a.tile.state] ?? 9) - (RANK[b.tile.state] ?? 9) || lastAt(b.s) - lastAt(a.s)), [state.sessions]);
  const session = open ? state.sessions[open] : null;
  const needs = rows.filter((r) => r.tile.state === "needs_you").length;
  const lamp = remote.connected ? (remote.live ? "live" : "sync") : "off";

  return (
    <div className="mm-screen">
      <header className="mm-band" data-mr="MobileBar">
        {session ? <button type="button" className="mr-key" onClick={() => setOpen(null)}>‹ Wall</button> : <strong className="mm-grow">{remote.paired?.name}</strong>}
        {session && <span className="mm-grow" />}
        <span data-mr="MobileLink" data-mr-source={lamp} className="mm-link" data-on={lamp}>
          {remote.connected ? (remote.live ? "Live" : "Catching up…") : remote.error ? "Mac unreachable" : "Connecting…"}
        </span>
        {!session && <button type="button" className="mr-key" data-mr="MobileStartOpen" onClick={() => { setMenu(false); setStarting(!starting); }}>＋</button>}
        {!session && <button type="button" className="mr-key" aria-label="Menu" onClick={() => { setStarting(false); setMenu(!menu); }}>⋯</button>}
      </header>
      {menu && !session && <Menu remote={remote} onClose={() => setMenu(false)} />}
      {starting && !session && <Start known={remote.known} live={remote.connected} onClose={() => setStarting(false)} onStarted={(id) => { setStarting(false); setOpen(id); }} />}
      {!remote.connected && remote.error && <p className="mm-note">{remote.error}. Showing what this phone last saw; it retries by itself.</p>}
      {session ? <Focus s={session} live={remote.connected} /> : (
        <main data-mr="MobileWall" className="mm-list">
          {!state.loaded ? <p className="mm-dim mm-pad">Loading…</p> : rows.length === 0 ? <p className="mm-dim mm-pad">No sessions on the Mac yet.</p> : (
            <>
              {needs > 0 && <p className="mm-section" data-on="needs">{needs} need{needs === 1 ? "s" : ""} you</p>}
              {rows.map(({ s, tile }) => (
                <button key={s.id} type="button" className="mm-row" data-mr="MobileTile" data-mr-source={s.id} data-state={tile.state} onClick={() => setOpen(s.id)}>
                  <span className="mm-lamp" data-state={tile.state} />
                  <span className="mm-grow mm-col">
                    <b className="mm-clip">{sessionTitle(s)}</b>
                    <span className="mm-dim mm-clip">{LABEL[tile.state]}{tile.doing ? ` · ${tile.doing}` : tile.step ? ` · ${tile.step}` : ""}</span>
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

function Menu({ remote, onClose }: { remote: RemoteState; onClose: () => void }) {
  const [msg, setMsg] = useState("");
  const forget = async () => {
    if (!confirm(`Forget ${remote.paired?.name}? This phone's copy of its sessions is wiped, and pairing again needs the Mac.`)) return;
    try { await invoke("remote_forget"); onClose(); } catch (e) { setMsg(shortError(e)); }
  };
  return (
    <div data-mr="MobileMenu" className="mm-sheet mm-pad">
      <span className="mm-dim">Paired with {remote.paired?.name}. Everything travels end to end encrypted, straight between this phone and the Mac.</span>
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

function Focus({ s, live }: { s: SessionState; live: boolean }) {
  const tile = pickTile(s);
  const { busy, err, run } = useSend();
  useEffect(() => { window.scrollTo(0, document.body.scrollHeight); }, [s.id]);
  const working = ["working", "starting", "almost"].includes(tile.state);
  return (
    <main data-mr="MobileFocus" data-mr-source={s.id} className="mm-col mm-focus">
      <div className="mm-pad mm-col" style={{ gap: 4 }}>
        <b>{sessionTitle(s)}</b>
        <span className="mm-row-flat">
          <span className="mm-dim mm-grow"><span className="mm-lamp" data-state={tile.state} /> {LABEL[tile.state]}{tile.progressLabel ? ` · ${tile.progressLabel}` : ""}</span>
          {working && <button type="button" className="mr-key" data-mr="MobileInterrupt" disabled={!live || !!busy} onClick={() => void run("interrupt", cmd.interrupt(s.id))}>{busy === "interrupt" ? "Stopping…" : "Interrupt"}</button>}
        </span>
      </div>
      {s.pending.map((a) => <Ask key={a.requestId} s={s} a={a} live={live} />)}
      <ol className="mm-transcript">
        {s.transcript.map((t) => <Item key={t.id} t={t} />)}
      </ol>
      {err && <p className="mm-error mm-pad">{err}</p>}
      <Composer s={s} live={live} />
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
function Start({ known, live, onClose, onStarted }: { known: Known; live: boolean; onClose: () => void; onStarted: (id: string) => void }) {
  const [ws, setWs] = useState(known.workspaces[0]?.id ?? "");
  const [repo, setRepo] = useState(known.repos[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const { busy, err, run } = useSend();
  const go = async () => {
    const r = await run("start", cmd.start(ws, repo, prompt));
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
      <textarea className="mm-input" rows={3} placeholder="What should Claude do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
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

function Item({ t }: { t: TranscriptItem }) {
  switch (t.kind) {
    case "user":
      return <li data-mr="MobileUser" data-mr-source={t.id} className="mm-user"><span className="mm-dim mm-mono">{t.via === "phone" ? "▯ phone →" : t.via === "doc" ? "▤ doc →" : t.via === "child" ? "↳ child →" : "you →"}</span><span className="mm-text">{t.text}</span></li>;
    case "text":
      return <li data-mr="MobileText" data-mr-source={t.id} className="mm-text">{t.text}</li>;
    case "tool":
      return <li data-mr="MobileTool" data-mr-source={t.id} className="mm-tool mm-mono mm-clip" data-error={t.isError ? "1" : undefined}>{t.name} {summarize(t.input)}</li>;
    case "view":
      return <li data-mr="MobileView" data-mr-source={t.id} className="mm-tool"><b>{t.title}</b> <span className="mm-dim">· open on the Mac for the full view</span></li>;
    case "result":
      return <li data-mr="MobileResult" data-mr-source={t.id} className="mm-dim mm-result">{t.ok ? "Turn ended" : "Turn failed"}</li>;
  }
}
