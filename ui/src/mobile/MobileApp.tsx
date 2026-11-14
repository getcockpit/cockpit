import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "../state/listen";
import { useAppState } from "../state/store";
import { pickTile } from "../picker/pick";
import { sessionTitle } from "../picker/title";
import { LABEL } from "../components";
import { shortError } from "../components/ErrorLine";
import type { SessionState, TranscriptItem } from "../state/types";

// Cockpit Remote on the iPhone (doc "Cockpit Remote", phase 2: read-only). The Mac is the brain:
// the mobile core (mobile/src-tauri) mirrors its event log, and the desktop's own store and reducer
// replay it here. Screens: Pair (first run), Wall (needs-you first), Focus (one session, read).

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
        {!session && <button type="button" className="mr-key" aria-label="Menu" onClick={() => setMenu(!menu)}>⋯</button>}
      </header>
      {menu && !session && <Menu remote={remote} onClose={() => setMenu(false)} />}
      {!remote.connected && remote.error && <p className="mm-note">{remote.error}. Showing what this phone last saw; it retries by itself.</p>}
      {session ? <Focus s={session} /> : (
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

function Focus({ s }: { s: SessionState }) {
  const tile = pickTile(s);
  useEffect(() => { window.scrollTo(0, document.body.scrollHeight); }, [s.id]);
  return (
    <main data-mr="MobileFocus" data-mr-source={s.id} className="mm-col">
      <div className="mm-pad mm-col" style={{ gap: 4 }}>
        <b>{sessionTitle(s)}</b>
        <span className="mm-dim"><span className="mm-lamp" data-state={tile.state} /> {LABEL[tile.state]}{tile.progressLabel ? ` · ${tile.progressLabel}` : ""}</span>
      </div>
      {s.pending.map((a) => (
        <div key={a.requestId} data-mr="MobileAsk" data-mr-source={a.requestId} className="mm-ask">
          <b>{a.kind === "question" ? "Claude asks" : `Allow ${a.tool}?`}</b>
          <span className="mm-clip3">{a.kind === "question" ? a.questions.map((q) => q.question).join(" · ") : summarize(a.input)}</span>
          <span className="mm-dim">Answer on the Mac for now; answering from the phone comes with Face ID.</span>
        </div>
      ))}
      <ol className="mm-transcript">
        {s.transcript.map((t) => <Item key={t.id} t={t} />)}
      </ol>
    </main>
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
