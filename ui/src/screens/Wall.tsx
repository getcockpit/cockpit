import { keyOf } from "../components/keys";
import { keyLabel } from "../platform";
import { ContextMeter } from "../components/ContextMeter";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LiveTrack, planSegs } from "../components/Now";
import { pointer } from "../components/pointer";
import { consumeDrag, dragSession } from "../components/dragToWorkspace";
import { suggest, USAGE_REVIEW, type Suggestion } from "../picker/suggest";
import { promptFor } from "./StartPicker";
import type { Pr } from "../state/store";
import { Bar, Key, ProgressTrack, StateMark, wayOut } from "../components";
import { pickTile, type TileSpec } from "../picker/pick";
import { docApi, docRole, docStage, groupByDoc, isBrief, isOpenQuestion, STAGE_LABEL, type Doc } from "../state/docs";
import { api } from "../state/store";
import { cached } from "../state/cache";
import { loadPrs as fetchPrs, prInWorkspace, PRS_TTL, startCwd, usePrClones } from "../state/prs";
import type { AppState, SessionState, Todo } from "../state/types";
import { answerAsk, AskRow, DocQuestionRow, FixRow, FlowRow, ProseRow, SignInRow } from "./AskRow";
import { needsQueue } from "../picker/queue";
import { prRepo, prSlug } from "../state/prRepo";
import { QuickStart } from "../components/QuickStart";
import { NoClaude } from "../components/NoClaude";
import { plural, sessionTitle } from "../picker/title";
import { ViewTabs } from "../components/ViewTabs";

// The wall (decision 17): lamps, a keyboard-driven needs-you queue, a stable running grid that
// never reorders by state, and a compact ready-to-review tray.

// A session waiting for your next step ("idle") stays in the running grid, where its tile says
// "Waiting · Your turn"; only finished, stopped or failed work goes to the review tray.
const REVIEW = new Set<TileSpec["state"]>(["review", "done", "interrupted", "error"]);
export const inReviewTray = (t: TileSpec) => REVIEW.has(t.state);

export function Wall({ state, all = state, workspace = "personal", docs, archived, onArchive, onOpen, onSignIn, onOpenDoc, onStart, onBuild, onTimeline, onSettings, onRecurring }: { onRecurring?: () => void; state: AppState; all?: AppState; workspace?: string; docs: Doc[]; archived: number; onArchive: () => void; onOpen: (id: string) => void; onSignIn?: (s: SessionState) => void; onOpenDoc: (id: string) => void; onStart: (init?: { mode: "review" | "address"; text: string }) => void; onBuild: (worktree: string) => void; onTimeline?: () => void; onSettings?: () => void }) {
  const sessions = state.order.map((id) => state.sessions[id]);
  const tiles = useMemo(() => sessions.map((s) => ({ s, tile: pickTile(s) })), [sessions]);
  // One queue for everything waiting on you; every needs-you count reads from it (MR-41).
  const queue = useMemo(() => needsQueue(sessions, docs), [sessions, docs]);
  const running = tiles.filter((t) => !inReviewTray(t.tile));
  const review = tiles.filter((t) => inReviewTray(t.tile));
  const tileOf = useMemo(() => new Map(running.map((t) => [t.s.id, t])), [running]);
  const grouped = useMemo(() => groupByDoc(docs, running.map((t) => t.s.id)), [docs, running]);
  const count = (k: TileSpec["state"]) => tiles.filter((t) => t.tile.state === k).length;
  const [sel, setSel] = useState(0);
  const cwd = startCwd();
  // Cached across wall mounts (MR-57): a workspace switch shows the last values instantly.
  const loadPrs = () => fetchPrs(cwd);
  const loadDaily = () => invoke<{ streak: number; goal: number }>("daily_driver");
  const [prs, setPrs] = useState<{ review: Pr[]; mine: Pr[] }>(() => cached("prs", PRS_TTL, loadPrs, () => {}) ?? { review: [], mine: [] });
  const [daily, setDaily] = useState<{ streak: number; goal: number } | null>(() => cached("daily", 10 * 60_000, loadDaily, () => {}) ?? null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      cached("prs", PRS_TTL, loadPrs, (v) => alive && setPrs(v));
      cached("daily", 10 * 60_000, loadDaily, (v) => alive && setDaily(v));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [cwd]);

  // Only the owner's Mac has the app repo; that gates the weekly usage review (MR-106).
  const [appRepo, setAppRepo] = useState<string | null>(null);
  useEffect(() => { invoke<string>("app_repo_path").then(setAppRepo).catch(() => setAppRepo(null)); }, []);
  // A PR's suggestion shows only in the workspaces that work in its repo (or everywhere, until one does).
  const clones = usePrClones([...prs.review, ...prs.mine]);
  const prsHere = useMemo(() => {
    const here = (p: Pr) => prInWorkspace(p, clones, all, workspace);
    return { review: prs.review.filter(here), mine: prs.mine.filter(here) };
  }, [prs, clones, all, workspace]);
  const suggestions = useMemo(() => suggest(state, docs, prsHere, new Set(state.dismissed), appRepo), [state, docs, prsHere, appRepo]);
  const act = async (g: Suggestion) => {
    const a = g.action;
    if (a.kind === "open_session") onOpen(a.id);
    else if (a.kind === "open_doc") onOpenDoc(a.id);
    else if (a.kind === "build_mine") onBuild(await api.mineWorktree());
    else if (a.kind === "docs_done") { for (const id of a.ids) { const d = docs.find((x) => x.id === id); if (d) await docApi.done(d); } }
    else if (a.kind === "usage_review") { onOpen(await api.start(a.repo, USAGE_REVIEW, "blank", false)); void api.log("ui.suggestion_dismissed", { id: g.id }); }
    else if (a.kind === "resume") { const s = state.sessions[a.id]; if (s) await api.resume(s); }
    else {
      const slug = prSlug(a.value) ?? a.repo ?? null;
      const where = slug ? await prRepo(slug) : cwd;
      if (where) onOpen(await api.start(where, promptFor(a.mode, a.value), a.mode));
      else onStart({ mode: a.mode, text: a.value }); // the picker asks where the clone is
    }
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const discover = async (s: SessionState) => onOpen(await sideThread(s));

  // J/K move over both tiers (MR-107): Blocking first, then Your call.
  const rows = queue.length + suggestions.length;
  useEffect(() => { if (sel >= rows) setSel(Math.max(0, rows - 1)); }, [rows, sel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      // An overlay (intro, picker, settings) owns the keyboard while it's open.
      if (typing || e.metaKey || e.ctrlKey || !rows || document.querySelector('[role="dialog"]')) return;
      const k = keyOf(e);
      if (k === "j") { e.preventDefault(); setSel((x) => Math.min(rows - 1, x + 1)); return; }
      if (k === "k") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); return; }
      const call = suggestions[sel - queue.length];
      if (call) {
        if (k === "Enter") { e.preventDefault(); void act(call); }
        else if (k === "x") { e.preventDefault(); void api.log("ui.suggestion_dismissed", { id: call.id }); }
        return;
      }
      const cur = queue[sel];
      if (!cur) return;
      if (cur.kind === "ask" && k === "a" && cur.a.kind === "permission") { e.preventDefault(); void answerAsk(cur.s, cur.a, { kind: "allow" }); }
      else if (cur.kind === "ask" && k === "d" && cur.a.kind === "permission") { e.preventDefault(); void answerAsk(cur.s, cur.a, { kind: "deny" }); }
      else if (cur.kind === "ask" && k === "s" && cur.a.kind === "question") { e.preventDefault(); void answerAsk(cur.s, cur.a, wayOut(cur.a.questions, { kind: "skip" })); }
      else if (cur.kind === "doc" && k === "s") { e.preventDefault(); (document.querySelector(`[data-mr-source="${cur.d.id}:${cur.b.id}"] [data-mr="WayOut"] button:last-child`) as HTMLButtonElement | null)?.click(); }
      else if (cur.kind === "prose" && /^[1-9]$/.test(k) && cur.options[Number(k) - 1]) { e.preventDefault(); void api.send(cur.s.id, cur.options[Number(k) - 1]); }
      else if (cur.kind === "prose" && k === "r") { e.preventDefault(); (document.querySelector(`[data-reply="${cur.s.id}"]`) as HTMLInputElement | null)?.focus(); }
      else if (cur.kind === "doc" && /^[1-9]$/.test(k)) { const o = (cur.b.data?.options ?? [])[Number(k) - 1]; if (o) { e.preventDefault(); (document.querySelector(`[data-mr-source="${cur.d.id}:${cur.b.id}"] [data-option="${Number(k) - 1}"]`) as HTMLButtonElement | null)?.click(); } }
      else if (k === "Enter") { e.preventDefault(); if (cur.kind === "doc") onOpenDoc(cur.d.id); else if (cur.kind === "signin" && onSignIn) onSignIn(cur.s); else onOpen(cur.s.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue, suggestions, rows, sel, onOpen, onOpenDoc, onSignIn]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      {/* One compact header (MR-53): status counts inline; zero counts fade; each jumps to its section. */}
      <header className="mr-band mr-row" style={{ padding: "10px 24px", gap: 6, flexWrap: "wrap" }}>
        {onTimeline ? <ViewTabs on="wall" onSwitch={onTimeline} /> : <strong style={{ fontSize: 15, marginRight: 10 }}>Wall</strong>}
        {(sessions.length > 0 || queue.length > 0) && <>
          <Count n={queue.length} label="need you" tone="needs" onClick={() => jump("mr-needs")} />
          <Count n={count("error")} label={count("error") === 1 ? "error" : "errors"} tone="error" onClick={() => jump("mr-review")} />
          <Count n={running.length} label="running" onClick={() => jump("mr-running")} />
          <Count n={count("almost")} label="almost done" onClick={() => jump("mr-running")} />
          <Count n={review.length} label="to review" onClick={() => jump("mr-review")} />
        </>}
        <span className="mr-grow" />
        {/* Recurring sessions (MR-167): the list, editor and runs. */}
        {onRecurring && <button type="button" data-mr="RecurringButton" data-mr-source="recurring" className="mr-key" onClick={onRecurring} title="Recurring sessions: run a saved prompt on a schedule" style={{ minHeight: 28, marginRight: 8 }}>
          ↻ Recurring{Object.keys(state.schedules).length ? ` ${Object.values(state.schedules).filter((x) => !x.paused).length}` : ""}
        </button>}
        {/* Never ask is on (I109): a red lamp for as long as it is; click for Settings. */}
        {state.permissionMode === "never" && (
          <button type="button" data-mr="NeverAskLamp" data-mr-source="never" onClick={onSettings} title="Sessions act without asking, except for high-risk actions. Click to change it in Settings."
            className="mr-row" style={{ gap: 6, border: 0, padding: "3px 10px", marginRight: 8, font: "inherit", fontWeight: 700, cursor: "pointer", background: "var(--mr-error)", color: "var(--mr-tile)" }}>
            <span aria-hidden>●</span>Never ask
          </button>
        )}
        <Usage label="5-hour" v={state.usage.fiveHour} resets={state.usage.resetsAt} />
        <Usage label="Week" v={state.usage.weekly} resets={state.usage.weeklyResetsAt} />
        <span className="mr-mono" title={!state.sidecar.up ? "Claude Code isn't connected" : state.sidecar.claude ? `Claude Code: ${state.sidecar.claude}` : "Claude Code isn't installed"} style={{ color: !state.sidecar.up ? "var(--mr-error)" : state.sidecar.claude ? "var(--mr-done)" : "var(--mr-needs)" }}>●</span>
      </header>


      <main style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, padding: "16px 24px 24px" }}>
        {state.sidecar.up && !state.sidecar.claude && <NoClaude />}
        {rows > 0 && (
          <section id="mr-needs" aria-label="Needs you" style={{ display: "flex", flexDirection: "column", gap: 8, scrollMarginTop: 12 }}>
            <h2 className="mr-h"><span style={{ color: queue.length ? "var(--mr-needs-ink)" : "var(--mr-ink-3)" }}>◆</span>Needs you<span className="mr-grow" /><span className="mr-dim" style={{ fontWeight: 400 }}>J/K move · A/D allow/deny · 1–3 pick · S skip · R reply · X dismiss · ↵ open</span></h2>
            {queue.length > 0 && <div className="mr-queue">
              {queue.map((q, i) =>
                q.kind === "ask" ? <AskRow key={q.key} s={q.s} a={q.a} selected={i === sel} onOpen={() => onOpen(q.s.id)} />
                : q.kind === "signin" ? <SignInRow key={q.key} s={q.s} selected={i === sel} onOpen={() => (onSignIn ? onSignIn(q.s) : onOpen(q.s.id))} />
                : q.kind === "fix" ? <FixRow key={q.key} s={q.s} selected={i === sel} onOpen={() => onOpen(q.s.id)} />
                : q.kind === "flow" ? <FlowRow key={q.key} s={q.s} what={q.what} selected={i === sel} onOpen={() => onOpen(q.s.id)} />
                : q.kind === "prose" ? <ProseRow key={q.key} s={q.s} question={q.question} options={q.options} selected={i === sel} onOpen={() => onOpen(q.s.id)} />
                : <DocQuestionRow key={q.key} d={q.d} b={q.b} session={q.d.session_id ? state.sessions[q.d.session_id] : null} selected={i === sel} onOpen={() => onOpenDoc(q.d.id)} />)}
            </div>}
            {/* Your call (MR-107): worth doing, but nothing is blocked on it, so no amber, no count, no notification. */}
            {suggestions.length > 0 && <>
              <h3 className="mr-dim" style={{ margin: queue.length ? "6px 0 0" : 0, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Your call <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· nothing waits on these</span></h3>
              <div className="mr-queue">
                {suggestions.map((g, i) => <CallRow key={g.id} g={g} selected={queue.length + i === sel} onAct={() => void act(g)} />)}
              </div>
            </>}
          </section>
        )}

        {sessions.length === 0 && rows === 0 && <QuickStart state={state} workspace={workspace} onStarted={onOpen} onMore={(mode) => onStart({ mode, text: "" })} />}

        {(running.length > 0 || docs.length > 0) && <section aria-label="Running" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 className="mr-h" id="mr-running" style={{ scrollMarginTop: 12 }}>Running <span className="mr-dim">{running.length}</span></h2>
          <div className="mr-grid">
            {/* A doc and the sessions that plan and build it, as one group across the grid (MR-168). */}
            {grouped.groups.map(({ doc, sessions: members }) => (
              <div key={doc.id} data-mr="DocGroup" data-mr-source={doc.id} style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 6, padding: 8, background: "var(--mr-well)" }}>
                <DocTile d={doc} sessions={state.sessions} onOpenDoc={onOpenDoc} header />
                <div className="mr-grid">
                  {members.map(({ id, role }) => tileOf.get(id) && <Tile key={id} s={tileOf.get(id)!.s} tile={tileOf.get(id)!.tile} docTag={{ doc, role }} grouped compactWindow={state.compactWindow} onOpen={onOpen} onOpenDoc={onOpenDoc} onDiscover={() => void discover(tileOf.get(id)!.s)} />)}
                </div>
              </div>
            ))}
            {grouped.loose.map((id) => { const { s, tile } = tileOf.get(id)!; return <Tile key={id} s={s} tile={tile} docTag={null} compactWindow={state.compactWindow} onOpen={onOpen} onOpenDoc={onOpenDoc} onDiscover={() => void discover(s)} />; })}
            {grouped.idle.map((d) => <DocTile key={d.id} d={d} sessions={state.sessions} onOpenDoc={onOpenDoc} />)}
            <button type="button" className="mr-tile" onClick={() => onStart()} style={{ alignItems: "center", justifyContent: "center", color: "var(--mr-ink-3)", background: "var(--mr-well)" }}>
              <span className="mr-row" style={{ padding: 16 }}><kbd className="mr-mono" style={{ padding: "2px 6px", background: "var(--mr-ink)", color: "var(--mr-tile)" }}>{keyLabel("⌘K")}</kbd>Start something</span>
            </button>
          </div>
        </section>}

        {review.length > 0 && (
          <section id="mr-review" aria-label="Ready to review" style={{ display: "flex", flexDirection: "column", gap: 8, scrollMarginTop: 12 }}>
            <h2 className="mr-h">Ready to review <span className="mr-dim">{review.length}</span></h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 380px), 1fr))", gap: "var(--mr-gap)" }}>
              {review.map(({ s, tile }) => (
                <button key={s.id} type="button" className="mr-row" data-mr="ReviewRow" data-mr-source={s.id} {...dragSession(s, sessionTitle(s))} onClick={() => { if (!consumeDrag()) onOpen(s.id); }} style={{ padding: "10px 12px", border: 0, background: "var(--mr-well)", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left", touchAction: "none" }}>
                  <StateMark s={tile.state} />
                  <span className="mr-grow mr-ellipsis">{s.schedule && <RecurringTag s={s} name={state.schedules[s.schedule]?.name} />}{sessionTitle(s)}</span>
                  {Object.keys(s.files).length > 0 && <span className="mr-mono mr-dim" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{plural(Object.keys(s.files).length, "file")}</span>}
                  <span className="mr-key" role="button" tabIndex={0} title="Mark done and move to the archive" style={{ minHeight: 28 }} onClick={(e) => { e.stopPropagation(); void api.archive(s); }} onKeyDown={(e) => { if (keyOf(e) === "Enter") { e.stopPropagation(); void api.archive(s); } }}>Done ✓</span>
                  {s.status === "interrupted" && s.sdkSessionId && <span className="mr-key" role="button" tabIndex={0} style={{ minHeight: 28 }} onClick={(e) => { e.stopPropagation(); void api.resume(s); }} onKeyDown={(e) => { if (keyOf(e) === "Enter") { e.stopPropagation(); void api.resume(s); } }}>Resume ↻</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
      <footer className="mr-band mr-row mr-dim" style={{ padding: "8px 24px", fontSize: 12 }}>
        {/* Calm footer (MR-53): one hint, the two places you go from here, and a quiet progress note. */}
        <span>Right-click anything for actions · {keyLabel("⌘-click")} to go deeper</span>
        <span className="mr-grow" />
        {daily && <span className="mr-mono" title="Days in a row using only this app for Claude Code (v1 goal: 7)" style={{ color: daily.streak >= daily.goal ? "var(--mr-done)" : "var(--mr-ink-3)" }}>{daily.streak}/{daily.goal} days</span>}
        <button type="button" className="mr-link" onClick={() => api.report()}>Report a bug</button>
        <button type="button" className="mr-link" onClick={onArchive}>Archive{archived ? ` (${archived})` : ""} <kbd className="mr-mono">{keyLabel("⌘⇧A")}</kbd></button>
        <Key k="⌘K" tone="primary" onClick={() => onStart()}>Start</Key>
      </footer>
    </div>
  );
}

// A working doc on the Wall: a tile of its own, or the header of its group (MR-168).
function DocTile({ d, sessions, onOpenDoc, header }: { d: Doc; sessions: AppState["sessions"]; onOpenDoc: (id: string) => void; header?: boolean }) {
  const blocks = Object.values(d.blocks);
  const open = blocks.filter(isOpenQuestion).length;
  const stage = isBrief(d) ? null : docStage(d, sessions);
  const meta = `v${d.version} · ${blocks.length} blocks${stage ? ` · ${STAGE_LABEL[stage]}` : ""}${open ? ` · ${open} open question${open === 1 ? "" : "s"}` : ""}`;
  const goal = blocks.find((b) => b.section === "goal")?.takeaway ?? "";
  return (
    <button type="button" className="mr-tile" data-mr="DocTile" data-mr-source={d.id} data-s={open ? "needs_you" : stage === "shipped" ? "done" : "working"} onClick={() => onOpenDoc(d.id)} style={header ? { minHeight: 0 } : { minHeight: 96 }}>
      <div className="mr-flag" />
      {header
        ? <div className="mr-tbody" style={{ flexDirection: "row", gap: 12, alignItems: "baseline", padding: "8px 14px" }}>
            <span className="mr-mono mr-dim" aria-hidden="true" style={{ fontSize: 12 }}>▤ doc</span>
            <strong className="mr-ellipsis" style={{ fontSize: 15 }}>{d.title}</strong>
            <span className="mr-ink2 mr-ellipsis mr-grow">{goal}</span>
            <span className="mr-mono mr-dim" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{meta}</span>
          </div>
        : <div className="mr-tbody">
            <strong style={{ fontSize: 15 }}>{d.title}</strong>
            <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{meta}</span>
            <span className="mr-ink2 mr-ellipsis">{goal}</span>
          </div>}
    </button>
  );
}

// A "Your call" row (MR-107): the move, why, and dismiss. Quiet: a well, not an amber flag.
function CallRow({ g, selected, onAct }: { g: Suggestion; selected: boolean; onAct: () => void }) {
  return (
    <div className="mr-row" data-mr="Suggestion" data-mr-source={g.id} aria-current={selected || undefined} style={{ gap: 14, padding: "10px 12px 10px 18px", background: "var(--mr-well)", ...(selected ? { outline: "2px solid var(--mr-selected)", outlineOffset: -2 } : {}) }}>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <span className="mr-dim mr-ellipsis">{g.why}</span>
        <span className="mr-ink2 mr-ellipsis">{g.what}</span>
      </span>
      <Key k={selected ? "↵" : undefined} onClick={onAct}>{g.label}</Key>
      <button type="button" aria-label="Dismiss" title="Dismiss (X)" onClick={() => void api.log("ui.suggestion_dismissed", { id: g.id })} style={{ padding: "6px 8px", border: 0, background: "transparent", color: "var(--mr-ink-3)", cursor: "pointer" }}>×</button>
    </div>
  );
}

/** ⌥-click on a session (decision 21): a read-only side thread about it. Resolves to the new session's id. */
export function sideThread(s: SessionState): Promise<string> {
  return api.start(s.cwd, `Side thread about the session "${s.title}" (working in ${s.cwd}). Without changing anything, look at what it has done so far (git diff, files) and report briefly: risks, anything it may have missed, and simpler alternatives.`, "blank", false);
}

function Tile({ s, tile, docTag, grouped, compactWindow, onOpen, onOpenDoc, onDiscover }: { s: SessionState; tile: TileSpec; docTag: ReturnType<typeof docRole>; grouped?: boolean; compactWindow: number | null; onOpen: (id: string) => void; onOpenDoc: (id: string) => void; onDiscover: () => void }) {
  return (
    <button type="button" className="mr-tile" data-mr="Tile" data-mr-source={s.id} data-mr-layer="code" data-s={tile.state} {...dragSession(s, sessionTitle(s))} onClick={(e) => { if (!consumeDrag()) pointer({ open: () => onOpen(s.id), deeper: () => onOpen(s.id), discover: onDiscover })(e); }} style={{ touchAction: "none" }} aria-label={`Open ${s.title}`}>
      <div className="mr-flag" />
      <div className="mr-tbody">
        <div className="mr-row" style={{ alignItems: "baseline" }}>
          <strong className="mr-grow mr-ellipsis" style={{ fontSize: 15 }}>{s.schedule && <RecurringTag s={s} />}{sessionTitle(s)}</strong>
          <StateMark s={tile.state} />
        </div>
        <div className="mr-row" style={{ gap: 8 }}>
          <span className="mr-mono mr-dim mr-ellipsis mr-grow" style={{ fontSize: 12 }}>{s.kind !== "blank" && s.kind !== docTag?.role ? `${s.kind} · ` : ""}{s.branch ?? s.cwd}</span>
          {docTag && <span role="link" tabIndex={-1} className="mr-mono mr-ellipsis" data-mr="DocTag" data-mr-source={docTag.doc.id} title={`${docTag.role === "build" ? "Builds" : "Plans"} the working doc “${docTag.doc.title}”: click to open it`} onClick={(e) => { e.stopPropagation(); onOpenDoc(docTag.doc.id); }} style={{ fontSize: 12, padding: "0 6px", background: "var(--mr-well)", color: "var(--mr-ink-2)", flexShrink: 0, maxWidth: "60%", cursor: "pointer" }}>▤ {docTag.role}{grouped ? "" : ` · ${docTag.doc.title}`}</span>}
          {s.goal && <span className="mr-mono" data-mr="GoalMark" data-mr-source={s.id} title={`Goal: ${s.goal.condition}`} style={{ fontSize: 12, color: "var(--mr-selected)" }}>◎ goal</span>}
          <ContextMeter s={s} compactWindow={compactWindow} running={false} slim />
        </div>
        {s.status === "working" || s.status === "starting"
          ? <LiveTrack s={s} compact />
          : s.todos.length > 0
            ? <ProgressTrack segs={planSegs(s.todos)} pct={tile.progress === null ? null : Math.round(tile.progress * 100)} left={tile.planOpen ? tile.step : tileStep(s.todos, tile.step)} source={s.id} fill />
            : <div className="mr-row"><div className="mr-grow"><Bar value={tile.progress} tone={tile.state === "needs_you" ? "needs" : undefined} /></div><span className="mr-mono mr-ink2" style={{ fontSize: 12 }}>{tile.progressLabel || tile.step}</span></div>}
        {tileNote(tile) && <span className="mr-ink2" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{tileNote(tile)}</span>}
      </div>
    </button>
  );
}

// A recurring run (MR-167): ↻ in teal, and "new" until you open it.
function RecurringTag({ s, name }: { s: SessionState; name?: string }) {
  return (
    <span data-mr="RecurringTag" data-mr-source={s.id} title={name ? `Recurring: ${name}` : "Started by a recurring schedule"} style={{ marginRight: 6, fontWeight: 700, color: "var(--mr-selected)" }}>
      ↻{s.unread && <span data-mr="Unread" data-mr-source={s.id} className="mr-mono" style={{ marginLeft: 4, padding: "0 4px", fontSize: 11, background: "var(--mr-selected)", color: "var(--mr-tile)" }}>new</span>}
    </span>
  );
}

// The tile's last line, only when it needs you: what Claude asks or wants, or where it stopped.
// Activity (the running tool or command, background tasks, the sparkline) never shows on a tile;
// the track's caption names the plan step instead (god-mode mark).
export function tileNote(tile: TileSpec): string {
  return tile.state === "needs_you" || tile.state === "interrupted" ? tile.doing : "";
}

// The track's caption on a resting tile: the name of the plan step in progress (or next up),
// falling back to the picker's "Step n of m" / "All n steps done".
export function tileStep(todos: Todo[], fallback: string): string {
  const t = todos.find((x) => x.status === "in_progress") ?? todos.find((x) => x.status === "pending");
  return t ? t.activeForm || t.content : fallback;
}

// When a limit window resets: a short countdown shown inline, and the exact time for the tooltip.
export function resetLabel(resets: number | null | undefined, now = Date.now()): { short: string; full: string } | null {
  if (!resets) return null;
  const at = new Date(resets * 1000), mins = Math.max(0, Math.round((at.getTime() - now) / 60000));
  const short = mins < 60 ? `${mins}m` : mins < 24 * 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : at.toLocaleDateString([], { weekday: "short" });
  const full = at.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return { short, full: `Resets ${full}` };
}

function Usage({ label, v, resets }: { label: string; v: number | null; resets?: number | null }) {
  const high = v !== null && v >= 0.8;
  const when = resetLabel(resets);
  return (
    <span className="mr-row" data-mr="Usage" data-mr-source={label} style={{ gap: 6 }} title={when?.full}>
      <span className="mr-dim">{label}</span>
      <span style={{ width: 64, height: 4, background: "var(--mr-well)", display: "inline-block" }}><span style={{ display: "block", height: 4, width: `${Math.round((v ?? 0) * 100)}%`, background: high ? "var(--mr-needs)" : "var(--mr-ink-3)" }} /></span>
      <span className="mr-mono" style={{ color: high ? "var(--mr-needs-ink)" : "var(--mr-ink-2)" }}>{v === null ? "—" : `${Math.round(v * 100)}%`}</span>
      {when && <span className="mr-dim mr-mono">↻ {when.short}</span>}
    </span>
  );
}

// A status count in the header: loud when it matters, faded at zero.
function Count({ n, label, tone, onClick }: { n: number; label: string; tone?: "needs" | "error"; onClick: () => void }) {
  const on = n > 0;
  const bg = on && tone === "needs" ? "var(--mr-needs)" : on && tone === "error" ? "var(--mr-error)" : "transparent";
  const fg = on && tone === "error" ? "var(--mr-tile)" : on ? "var(--mr-ink)" : "var(--mr-ink-3)";
  return (
    <button type="button" data-mr="Lamp" data-mr-source={label} onClick={onClick} disabled={!on} aria-label={`${n} ${label}`}
      style={{ display: "inline-flex", alignItems: "baseline", gap: 6, padding: "4px 10px", border: 0, background: bg, color: fg, font: "inherit", fontWeight: on ? 700 : 400, cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.6 }}>
      <b className="mr-mono" style={{ fontSize: 16 }}>{n}</b><span>{label}</span>
    </button>
  );
}
