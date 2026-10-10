import { keyOf } from "../components/keys";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pointer } from "../components/pointer";
import { suggest, type Suggestion } from "../picker/suggest";
import { promptFor } from "./StartPicker";
import type { Pr } from "../state/store";
import { Bar, Key, Lamp, Lamps, Sparkline, StateMark } from "../components";
import { pickTile, type TileSpec } from "../picker/pick";
import { isOpenQuestion, type Doc } from "../state/docs";
import { api } from "../state/store";
import type { AppState, SessionState } from "../state/types";
import { answerAsk, AskRow, DocQuestionRow, ProseRow } from "./AskRow";
import { needsQueue } from "../picker/queue";
import { QuickStart } from "../components/QuickStart";
import { sessionTitle } from "../picker/title";

// The wall (decision 17): lamps, a keyboard-driven needs-you queue, a stable running grid that
// never reorders by state, and a compact ready-to-review tray.

const REVIEW = new Set<TileSpec["state"]>(["idle", "done", "interrupted", "error"]);

export function Wall({ state, docs, archived, onArchive, onOpen, onOpenDoc, onStart }: { state: AppState; docs: Doc[]; archived: number; onArchive: () => void; onOpen: (id: string) => void; onOpenDoc: (id: string) => void; onStart: () => void }) {
  const sessions = state.order.map((id) => state.sessions[id]);
  const tiles = useMemo(() => sessions.map((s) => ({ s, tile: pickTile(s) })), [sessions]);
  // One queue for everything waiting on you; every needs-you count reads from it (MR-41).
  const queue = useMemo(() => needsQueue(sessions, docs), [sessions, docs]);
  const running = tiles.filter((t) => !REVIEW.has(t.tile.state));
  const review = tiles.filter((t) => REVIEW.has(t.tile.state));
  const count = (k: TileSpec["state"]) => tiles.filter((t) => t.tile.state === k).length;
  const [sel, setSel] = useState(0);
  const [prs, setPrs] = useState<{ review: Pr[]; mine: Pr[] }>({ review: [], mine: [] });
  const [daily, setDaily] = useState<{ streak: number; goal: number } | null>(null);
  const cwd = (() => { try { return localStorage.getItem("mr.cwd") ?? "~/"; } catch { return "~/"; } })();

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.allSettled([api.prs(cwd, "review"), api.prs(cwd, "address")]).then(([r, m]) => alive && setPrs({ review: r.status === "fulfilled" ? r.value : [], mine: m.status === "fulfilled" ? m.value : [] }));
      invoke<{ streak: number; goal: number }>("daily_driver").then((d) => alive && setDaily(d)).catch(() => {});
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [cwd]);

  const suggestions = useMemo(() => suggest(state, docs, prs, new Set(state.dismissed)), [state, docs, prs]);
  const act = async (g: Suggestion) => {
    const a = g.action;
    if (a.kind === "open_session") onOpen(a.id);
    else if (a.kind === "open_doc") onOpenDoc(a.id);
    else if (a.kind === "resume") { const s = state.sessions[a.id]; if (s) await api.resume(s); }
    else onOpen(await api.start(cwd, promptFor(a.mode, a.value), a.mode));
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const discover = async (s: SessionState) => onOpen(await api.start(s.cwd, `Side thread about the session "${s.title}" (working in ${s.cwd}). Without changing anything, look at what it has done so far (git diff, files) and report briefly: risks, anything it may have missed, and simpler alternatives.`, "blank", false));

  useEffect(() => { if (sel >= queue.length) setSel(Math.max(0, queue.length - 1)); }, [queue.length, sel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      // An overlay (intro, picker, settings) owns the keyboard while it's open.
      if (typing || e.metaKey || e.ctrlKey || !queue.length || document.querySelector('[role="dialog"]')) return;
      const cur = queue[sel];
      const k = keyOf(e);
      if (k === "j") { e.preventDefault(); setSel((x) => Math.min(queue.length - 1, x + 1)); }
      else if (k === "k") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
      else if (cur.kind === "ask" && k === "a" && cur.a.kind === "permission") { e.preventDefault(); void answerAsk(cur.s, cur.a, { kind: "allow" }); }
      else if (cur.kind === "ask" && k === "d" && cur.a.kind === "permission") { e.preventDefault(); void answerAsk(cur.s, cur.a, { kind: "deny" }); }
      else if (cur.kind === "prose" && /^[1-9]$/.test(k) && cur.options[Number(k) - 1]) { e.preventDefault(); void api.send(cur.s.id, cur.options[Number(k) - 1]); }
      else if (cur.kind === "prose" && k === "r") { e.preventDefault(); (document.querySelector(`[data-reply="${cur.s.id}"]`) as HTMLInputElement | null)?.focus(); }
      else if (cur.kind === "doc" && /^[1-9]$/.test(k)) { const o = (cur.b.data?.options ?? [])[Number(k) - 1]; if (o) { e.preventDefault(); (document.querySelector(`[data-mr-source="${cur.d.id}:${cur.b.id}"] [data-option="${Number(k) - 1}"]`) as HTMLButtonElement | null)?.click(); } }
      else if (k === "Enter") { e.preventDefault(); if (cur.kind === "doc") onOpenDoc(cur.d.id); else onOpen(cur.s.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue, sel, onOpen, onOpenDoc]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <header className="mr-band mr-row" style={{ padding: "14px 24px" }}>
        <strong style={{ fontSize: 15 }}>Minority report</strong>
        <span className="mr-dim">Wall</span>
        <span className="mr-grow" />
        <Usage label="5-hour" v={state.usage.fiveHour} resets={state.usage.resetsAt} />
        <Usage label="Weekly" v={state.usage.weekly} />
        <span className="mr-mono mr-dim" title={state.sidecar.claude ?? ""}>{state.sidecar.up ? "● claude" : "○ claude"}</span>
      </header>

      {(sessions.length > 0 || queue.length > 0) && (
        <Lamps>
          <Lamp value={queue.length} label="Needs you" on={queue.length > 0 && "needs"} onClick={() => jump("mr-needs")} />
          <Lamp value={count("error")} label="Errors" on={count("error") > 0 && "error"} onClick={() => jump("mr-review")} />
          <Lamp value={count("almost")} label="Almost done" on={count("almost") > 0 && "plain"} onClick={() => jump("mr-running")} />
          <Lamp value={running.length} label="Running" on={running.length > 0 && "plain"} onClick={() => jump("mr-running")} />
          <Lamp value={review.length} label="To review" on={review.length > 0 && "plain"} onClick={() => jump("mr-review")} />
        </Lamps>
      )}

      {suggestions.length > 0 && (
        <section aria-label="Suggested next" className="mr-row" style={{ flexWrap: "wrap", gap: 8, padding: "12px 24px 0" }}>
          <span className="mr-dim">Suggested</span>
          {suggestions.map((g) => (
            <span key={g.id} data-mr="Suggestion" data-mr-source={g.id} className="mr-row" style={{ gap: 0, background: "var(--mr-tile)" }}>
              <button type="button" onClick={() => void act(g)} className="mr-row" style={{ gap: 8, padding: "6px 10px", border: 0, background: "transparent", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }} title={g.what}>
                <span className="mr-dim">{g.why} ·</span><strong>{g.label}</strong>
              </button>
              <button type="button" aria-label="Dismiss suggestion" onClick={() => void api.log("ui.suggestion_dismissed", { id: g.id })} style={{ padding: "6px 8px", border: 0, background: "transparent", color: "var(--mr-ink-3)", cursor: "pointer" }}>×</button>
            </span>
          ))}
        </section>
      )}

      <main style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, padding: "16px 24px 24px" }}>
        {queue.length > 0 && (
          <section id="mr-needs" aria-label="Needs you" style={{ display: "flex", flexDirection: "column", gap: 8, scrollMarginTop: 12 }}>
            <h2 className="mr-h"><span style={{ color: "var(--mr-needs-ink)" }}>◆</span>Needs you <span className="mr-dim">{queue.length}</span><span className="mr-grow" /><span className="mr-dim" style={{ fontWeight: 400 }}>J/K move · A/D allow/deny · 1–3 pick · R reply · ↵ open</span></h2>
            <div className="mr-queue">
              {queue.map((q, i) =>
                q.kind === "ask" ? <AskRow key={q.key} s={q.s} a={q.a} selected={i === sel} onOpen={() => onOpen(q.s.id)} />
                : q.kind === "prose" ? <ProseRow key={q.key} s={q.s} question={q.question} options={q.options} selected={i === sel} onOpen={() => onOpen(q.s.id)} />
                : <DocQuestionRow key={q.key} d={q.d} b={q.b} session={q.d.session_id ? state.sessions[q.d.session_id] : null} selected={i === sel} onOpen={() => onOpenDoc(q.d.id)} />)}
            </div>
          </section>
        )}

        {sessions.length === 0 && queue.length === 0 && <QuickStart onStarted={onOpen} onMore={onStart} />}

        {sessions.length > 0 && <section aria-label="Running" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 className="mr-h" id="mr-running" style={{ scrollMarginTop: 12 }}>Running <span className="mr-dim">{running.length}</span></h2>
          <div className="mr-grid">
            {running.map(({ s, tile }) => <Tile key={s.id} s={s} tile={tile} onOpen={onOpen} onDiscover={() => void discover(s)} />)}
            <button type="button" className="mr-tile" onClick={onStart} style={{ alignItems: "center", justifyContent: "center", color: "var(--mr-ink-3)", background: "var(--mr-well)" }}>
              <span className="mr-row" style={{ padding: 16 }}><kbd className="mr-mono" style={{ padding: "2px 6px", background: "var(--mr-ink)", color: "var(--mr-tile)" }}>⌘K</kbd>Start something</span>
            </button>
          </div>
        </section>}

        {docs.length > 0 && (
          <section aria-label="Working docs" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h">Working docs <span className="mr-dim">{docs.length}</span></h2>
            <div className="mr-grid">
              {docs.map((d) => {
                const blocks = Object.values(d.blocks);
                const open = blocks.filter(isOpenQuestion).length;
                return (
                  <button key={d.id} type="button" className="mr-tile" data-s={open ? "needs_you" : "working"} onClick={() => onOpenDoc(d.id)} style={{ minHeight: 96 }}>
                    <div className="mr-flag" />
                    <div className="mr-tbody">
                      <strong style={{ fontSize: 15 }}>{d.title}</strong>
                      <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>v{d.version} · {blocks.length} blocks{open ? ` · ${open} open question${open === 1 ? "" : "s"}` : ""}</span>
                      <span className="mr-ink2 mr-ellipsis">{blocks.find((b) => b.section === "goal")?.takeaway ?? ""}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {review.length > 0 && (
          <section id="mr-review" aria-label="Ready to review" style={{ display: "flex", flexDirection: "column", gap: 8, scrollMarginTop: 12 }}>
            <h2 className="mr-h">Ready to review <span className="mr-dim">{review.length}</span></h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: "var(--mr-gap)" }}>
              {review.map(({ s, tile }) => (
                <button key={s.id} type="button" className="mr-row" data-mr="ReviewRow" data-mr-source={s.id} onClick={() => onOpen(s.id)} style={{ padding: "10px 12px", border: 0, background: "var(--mr-well)", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
                  <StateMark s={tile.state} />
                  <span className="mr-grow mr-ellipsis">{sessionTitle(s)}</span>
                  <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{Object.keys(s.files).length} files</span>
                  <span className="mr-key" role="button" tabIndex={0} title="Mark done and move to the archive" style={{ minHeight: 28 }} onClick={(e) => { e.stopPropagation(); void api.archive(s); }} onKeyDown={(e) => { if (keyOf(e) === "Enter") { e.stopPropagation(); void api.archive(s); } }}>Done ✓</span>
                  {s.status === "interrupted" && s.sdkSessionId && <span className="mr-key" role="button" tabIndex={0} style={{ minHeight: 28 }} onClick={(e) => { e.stopPropagation(); void api.resume(s); }} onKeyDown={(e) => { if (keyOf(e) === "Enter") { e.stopPropagation(); void api.resume(s); } }}>Resume ↻</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
      <footer className="mr-band mr-row mr-dim" style={{ padding: "8px 24px", fontSize: 12 }}>
        <span>⌘K start · click focus · ⌘-click deeper · ⌥-click discover · ⌘⇧G god mode · ⌘⇧B builds</span>
        {daily && <span className="mr-mono" title="Days in a row using only this app for Claude Code (v1 goal: 7)" style={{ color: daily.streak >= daily.goal ? "var(--mr-done)" : "var(--mr-ink-2)" }}>Daily driver {daily.streak}/{daily.goal}</span>}
        <span className="mr-grow" />
        <Key k="⌘⇧A" onClick={onArchive}>Archive{archived ? ` · ${archived}` : ""}</Key>
        <Key k="⌘K" onClick={onStart}>Start</Key>
      </footer>
    </div>
  );
}

function Tile({ s, tile, onOpen, onDiscover }: { s: SessionState; tile: TileSpec; onOpen: (id: string) => void; onDiscover: () => void }) {
  return (
    <button type="button" className="mr-tile" data-mr="Tile" data-mr-source={s.id} data-mr-layer="code" data-s={tile.state} onClick={pointer({ open: () => onOpen(s.id), deeper: () => onOpen(s.id), discover: onDiscover })} aria-label={`Open ${s.title}`}>
      <div className="mr-flag" />
      <div className="mr-tbody">
        <div className="mr-row" style={{ alignItems: "baseline" }}>
          <strong className="mr-grow mr-ellipsis" style={{ fontSize: 15 }}>{sessionTitle(s)}</strong>
          <StateMark s={tile.state} />
        </div>
        <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 12 }}>{s.kind !== "blank" ? `${s.kind} · ` : ""}{s.branch ?? s.cwd}</span>
        <div className="mr-row"><div className="mr-grow"><Bar value={tile.progress} tone={tile.state === "needs_you" ? "needs" : undefined} /></div><span className="mr-mono mr-ink2" style={{ fontSize: 12 }}>{tile.progressLabel || tile.step}</span></div>
        <div className="mr-row" style={{ alignItems: "flex-end" }}>
          <span className="mr-grow mr-ink2" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{tile.doing}</span>
          <Sparkline values={s.activity} />
        </div>
      </div>
    </button>
  );
}

function Usage({ label, v, resets }: { label: string; v: number | null; resets?: number | null }) {
  const high = v !== null && v >= 0.8;
  const when = resets ? new Date(resets * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <span className="mr-row" style={{ gap: 6 }} title={when ? `Resets at ${when}` : undefined}>
      <span className="mr-dim">{label}</span>
      <span style={{ width: 64, height: 4, background: "var(--mr-well)", display: "inline-block" }}><span style={{ display: "block", height: 4, width: `${Math.round((v ?? 0) * 100)}%`, background: high ? "var(--mr-needs)" : "var(--mr-ink-3)" }} /></span>
      <span className="mr-mono" style={{ color: high ? "var(--mr-needs-ink)" : "var(--mr-ink-2)" }}>{v === null ? "—" : `${Math.round(v * 100)}%`}</span>
    </span>
  );
}
