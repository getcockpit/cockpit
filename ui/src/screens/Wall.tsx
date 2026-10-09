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
import { answerAsk, AskRow } from "./AskRow";

// The wall (decision 17): lamps, a keyboard-driven needs-you queue, a stable running grid that
// never reorders by state, and a compact ready-to-review tray.

const REVIEW = new Set<TileSpec["state"]>(["idle", "done", "interrupted", "error"]);

export function Wall({ state, docs, onOpen, onOpenDoc, onStart }: { state: AppState; docs: Doc[]; onOpen: (id: string) => void; onOpenDoc: (id: string) => void; onStart: () => void }) {
  const sessions = state.order.map((id) => state.sessions[id]);
  const tiles = useMemo(() => sessions.map((s) => ({ s, tile: pickTile(s) })), [sessions]);
  const asks = sessions.flatMap((s) => s.pending.map((a) => ({ s, a })));
  const openQs = docs.flatMap((d) => Object.values(d.blocks).filter(isOpenQuestion).map((b) => ({ d, b })));
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
  const discover = async (s: SessionState) => onOpen(await api.start(s.cwd, `Side thread about the session "${s.title}" (working in ${s.cwd}). Without changing anything, look at what it has done so far (git diff, files) and report briefly: risks, anything it may have missed, and simpler alternatives.`, "blank", false));

  useEffect(() => { if (sel >= asks.length) setSel(Math.max(0, asks.length - 1)); }, [asks.length, sel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || !asks.length) return;
      const cur = asks[sel];
      if (e.key === "j") { e.preventDefault(); setSel((x) => Math.min(asks.length - 1, x + 1)); }
      else if (e.key === "k") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
      else if (e.key === "a" && cur.a.kind === "permission") { e.preventDefault(); void answerAsk(cur.s, cur.a, { kind: "allow" }); }
      else if (e.key === "d" && cur.a.kind === "permission") { e.preventDefault(); void answerAsk(cur.s, cur.a, { kind: "deny" }); }
      else if (e.key === "Enter") { e.preventDefault(); onOpen(cur.s.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asks, sel, onOpen]);

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

      <Lamps>
        <Lamp value={asks.length + openQs.length} label="Needs you" on={asks.length + openQs.length > 0 && "needs"} />
        <Lamp value={count("error")} label="Errors" on={count("error") > 0 && "error"} />
        <Lamp value={count("almost")} label="Almost done" on={count("almost") > 0 && "plain"} />
        <Lamp value={running.length} label="Running" on={running.length > 0 && "plain"} />
        <Lamp value={review.length} label="To review" on={review.length > 0 && "plain"} />
      </Lamps>

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
        {asks.length > 0 && (
          <section aria-label="Needs you" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h"><span style={{ color: "var(--mr-needs-ink)" }}>◆</span>Needs you <span className="mr-dim">{asks.length}</span><span className="mr-grow" /><span className="mr-dim" style={{ fontWeight: 400 }}>J/K move · A allow · D deny · ↵ open</span></h2>
            <div className="mr-queue">{asks.map(({ s, a }, i) => <AskRow key={a.requestId} s={s} a={a} selected={i === sel} onOpen={() => onOpen(s.id)} />)}</div>
          </section>
        )}

        {openQs.length > 0 && (
          <section aria-label="Open questions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h"><span style={{ color: "var(--mr-needs-ink)" }}>◆</span>Open questions in docs <span className="mr-dim">{openQs.length}</span></h2>
            <div className="mr-queue">
              {openQs.map(({ d, b }) => (
                <button key={`${d.id}:${b.id}`} type="button" className="mr-qrow" onClick={() => onOpenDoc(d.id)} style={{ border: 0, padding: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
                  <div className="mr-flag" />
                  <div className="mr-qbody" style={{ flexDirection: "row", alignItems: "center" }}>
                    <div className="mr-grow" style={{ display: "flex", flexDirection: "column" }}><span className="mr-ink2">{d.title}</span><span className="mr-ask">{b.takeaway}</span></div>
                    <span className="mr-key">Decide ↵</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        <section aria-label="Running" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 className="mr-h">Running <span className="mr-dim">{running.length}</span></h2>
          <div className="mr-grid">
            {running.map(({ s, tile }) => <Tile key={s.id} s={s} tile={tile} onOpen={onOpen} onDiscover={() => void discover(s)} />)}
            <button type="button" className="mr-tile" onClick={onStart} style={{ alignItems: "center", justifyContent: "center", color: "var(--mr-ink-3)", background: "var(--mr-well)" }}>
              <span className="mr-row" style={{ padding: 16 }}><kbd className="mr-mono" style={{ padding: "2px 6px", background: "var(--mr-ink)", color: "var(--mr-tile)" }}>⌘K</kbd>Start something</span>
            </button>
          </div>
        </section>

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
          <section aria-label="Ready to review" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h">Ready to review <span className="mr-dim">{review.length}</span></h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: "var(--mr-gap)" }}>
              {review.map(({ s, tile }) => (
                <button key={s.id} type="button" className="mr-row" onClick={() => onOpen(s.id)} style={{ padding: "10px 12px", border: 0, background: "var(--mr-well)", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
                  <StateMark s={tile.state} />
                  <span className="mr-grow mr-ellipsis">{s.title || "Untitled"}</span>
                  <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{Object.keys(s.files).length} files</span>
                  {s.status === "interrupted" && s.sdkSessionId && <span className="mr-key" role="button" tabIndex={0} style={{ minHeight: 28 }} onClick={(e) => { e.stopPropagation(); void api.resume(s); }} onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void api.resume(s); } }}>Resume ↻</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
      <footer className="mr-band mr-row mr-dim" style={{ padding: "8px 24px", fontSize: 12 }}>
        <span>⌘K start · click focus · ⌘-click deeper · ⌥-click discover · esc back · ⌘. interrupt</span>
        {daily && <span className="mr-mono" title="Days in a row using only this app for Claude Code (v1 goal: 7)" style={{ color: daily.streak >= daily.goal ? "var(--mr-done)" : "var(--mr-ink-2)" }}>Daily driver {daily.streak}/{daily.goal}</span>}
        <span className="mr-grow" />
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
          <strong className="mr-grow mr-ellipsis" style={{ fontSize: 15 }}>{s.title || "Untitled"}</strong>
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
