import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { Key, ProgressTrack, type Seg } from ".";
import { pointer } from "./pointer";
import { modKey } from "../platform";
import { Diff } from "./Diff";
import { Markdown, inline } from "./Markdown";
import { Chips, Mark } from "./Turn";
import { FileRefChip } from "./FileChip";
import { CopyKey } from "./CopyKey";
import { ImageCompare, ImageGallery } from "./ImageReview";
import type { ViewBlock } from "../state/types";

// A view Claude composed with render_view (decision 26, MR-61): each block is one catalog
// component. The core validated the required fields; everything else is read defensively.

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const card = { padding: "12px 16px", background: "var(--mr-tile)" } as const;

type Tone = "done" | "todo" | "you" | "info";
const asTone = (v: unknown): Tone => (["done", "todo", "you", "info"].includes(str(v)) ? (str(v) as Tone) : "info");
const KICKER: Record<Tone, string> = { done: "Status", todo: "To do", you: "Needs you", info: "" };

function Takeaway({ b }: { b: ViewBlock }) {
  const status = asTone(b.status);
  return (
    <section style={{ ...card, boxShadow: status === "you" ? "inset 4px 0 0 var(--mr-needs)" : undefined }}>
      <div className="mr-row" style={{ gap: 8, marginBottom: 4 }}>
        {KICKER[status] && KICKER[status].toLowerCase() !== str(b.heading).trim().toLowerCase() && <span className="mr-dim" style={{ fontSize: 12 }}>{KICKER[status]} ·</span>}
        <strong style={{ fontSize: 15 }}>{str(b.heading)}</strong>
      </div>
      {list(b.items).map((it, i) => {
        const state = str(it.state);
        return (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "6px 0" }}>
            <span style={{ flex: "none", width: 14, display: "inline-flex", justifyContent: "center" }}>
              {state === "error" ? <span style={{ color: "var(--mr-error)", fontWeight: 700 }} aria-label="Error">✕</span> : <Mark tone={state ? asTone(state) : status} />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{inline(str(it.title))}</strong>
              {it.detail ? <span className="mr-ink2"> {inline(str(it.detail))}</span> : null}
            </span>
            {it.time ? <span className="mr-mono" style={{ flex: "none", fontSize: 11, padding: "1px 6px", background: "var(--mr-well)", color: "var(--mr-ink-2)" }}>{str(it.time)}</span> : null}
          </div>
        );
      })}
    </section>
  );
}

// Tally bar: a batch of outcomes as one bar, then the counts.
const TALLY: Record<string, string> = { done: "var(--mr-done)", now: "var(--mr-ink)", deferred: "var(--mr-ink-3)", todo: "var(--mr-well)", error: "var(--mr-error)" };
export function Tally({ b }: { b: ViewBlock }) {
  const items = list(b.items).map((x) => ({ n: Math.max(0, Number(x.n) || 0), label: str(x.label), color: TALLY[str(x.tone)] ?? TALLY.now }));
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", height: 10, gap: 2 }} aria-hidden="true">
        {items.filter((x) => x.n > 0).map((x, i) => <span key={i} style={{ flex: `${x.n} 1 0`, background: x.color }} />)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }} className="mr-ink2">
        {items.map((x, i) => <span key={i}><strong style={{ color: x.color === TALLY.todo ? "var(--mr-ink-2)" : x.color }}>{x.n}</strong> {x.label}</span>)}
      </div>
    </section>
  );
}

// Verification checklist: "done" only when the proof is green.
export function Checklist({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 6 }}>
      {list(b.items).map((c, i) => (
        <div key={i} className="mr-row" style={{ alignItems: "baseline", gap: 10 }}>
          <span style={{ width: 14, display: "inline-flex", justifyContent: "center" }}>
            {c.ok === true ? <Mark tone="done" /> : c.ok === false ? <span style={{ color: "var(--mr-error)", fontWeight: 700 }} aria-label="Failed">✕</span> : <Mark tone="todo" />}
          </span>
          <span className="mr-grow">{inline(str(c.label))}</span>
          {c.proof ? <span className="mr-mono mr-dim" style={{ fontSize: 11 }}>{str(c.proof)}</span> : null}
        </div>
      ))}
    </section>
  );
}

function Progress({ b }: { b: ViewBlock }) {
  const total = Math.max(1, Math.min(60, Number(b.total) || 1));
  const n = Math.max(0, Math.min(total, Number(b.n) || 0));
  const segs: Seg[] = Array.from({ length: total }, (_, i) => (i + 1 < n ? "done" : i + 1 === n ? "current" : "todo"));
  return <div style={card}><ProgressTrack segs={segs} left={`${str(b.label)} · ${n} of ${total}`} right={str(b.right) || undefined} /></div>;
}

// Option comparison: options as rows, criteria as columns, the recommendation marked.
function Compare({ b }: { b: ViewBlock }) {
  const criteria = list(b.criteria).map(str);
  return (
    <section style={{ ...card, overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>{["Option", ...criteria].map((c, i) => <th key={i} className="mr-dim" style={{ textAlign: "left", fontWeight: 600, fontSize: 12, padding: "4px 10px 6px 0" }}>{c}</th>)}</tr></thead>
        <tbody>
          {list(b.rows).map((r, i) => (
            <tr key={i} style={{ background: r.recommended ? "var(--mr-well)" : undefined }}>
              <td style={{ padding: "6px 10px 6px 0", fontWeight: 700 }}>{str(r.option)}{r.recommended ? <span className="mr-mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--mr-done)" }}>recommended</span> : null}</td>
              {criteria.map((_, j) => <td key={j} className="mr-ink2" style={{ padding: "6px 10px 6px 0" }}>{inline(str((Array.isArray(r.values) ? r.values : [])[j]))}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Change graph: what a change touches, + new, ~ changed, − removed. One change per row, never a
// wrapped chip pile: a row of chips joined by → broke mid-chain and read as a jumble. In flow order
// a rail joins the rows top to bottom; grouped (the review overview) it's New / Changed / Removed.
export type ChangeNode = { label: string; mark?: string; finding?: string | null };
const MARK = { "+": { word: "New", color: "var(--mr-done)" }, "~": { word: "Changed", color: "var(--mr-ink-2)" }, "-": { word: "Removed", color: "var(--mr-error)" } } as const;
type MarkKey = keyof typeof MARK;
const markOf = (n: ChangeNode): MarkKey => {
  const m = (n.mark ?? "").trim().replace("−", "-");
  if (m in MARK) return m as MarkKey;
  const lead = n.label.trim()[0];
  return lead && lead in MARK ? (lead as MarkKey) : "~";
};
// Claude often repeats the mark in the label ("+ paging"); drop it so it shows once.
export const changeLabel = (label: string) => label.replace(/^\s*[~+\-−]\s+/, "");

function ChangeRow({ n, rail }: { n: ChangeNode; rail?: "top" | "mid" | "bottom" | "only" }) {
  const m = MARK[markOf(n)];
  return (
    <div data-mr="ChangeRow" style={{ display: "flex", alignItems: "stretch", gap: 10, minHeight: 26 }}>
      <span style={{ flex: "none", width: 18, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {rail && rail !== "only" && <span aria-hidden style={{ position: "absolute", left: 8, width: 2, background: "var(--mr-well)", top: rail === "top" ? "50%" : 0, bottom: rail === "bottom" ? "50%" : 0 }} />}
        <b className="mr-mono" title={m.word} aria-label={m.word} style={{ position: "relative", width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, background: "var(--mr-well)", color: m.color }}>{markOf(n) === "-" ? "−" : markOf(n)}</b>
      </span>
      <span style={{ flex: "0 1 auto", minWidth: 0, alignSelf: "center", fontSize: 13, lineHeight: 1.35, overflowWrap: "anywhere" }}>{inline(changeLabel(n.label))}</span>
      {n.finding && <span style={{ flex: "none", alignSelf: "center", fontSize: 11, fontWeight: 700, padding: "1px 6px", background: "var(--mr-needs)", color: "var(--mr-ink)" }}>{n.finding}</span>}
    </div>
  );
}

export function ChangeList({ nodes, grouped }: { nodes: ChangeNode[]; grouped?: boolean }) {
  if (grouped) {
    const groups = (["+", "~", "-"] as MarkKey[]).map((k) => ({ k, items: nodes.filter((n) => markOf(n) === k) })).filter((g) => g.items.length);
    return (
      <div data-mr="ChangeList" style={{ display: "flex", flexWrap: "wrap", gap: "10px 28px" }}>
        {groups.map((g) => (
          <div key={g.k} style={{ flex: "1 1 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="mr-dim" style={{ fontSize: 12, fontWeight: 700 }}>{MARK[g.k].word} · {g.items.length}</span>
            {g.items.map((n, i) => <ChangeRow key={i} n={n} />)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div data-mr="ChangeList" style={{ display: "flex", flexDirection: "column" }}>
      {nodes.map((n, i) => <ChangeRow key={i} n={n} rail={nodes.length === 1 ? "only" : i === 0 ? "top" : i === nodes.length - 1 ? "bottom" : "mid"} />)}
    </div>
  );
}

function ChangeGraph({ b }: { b: ViewBlock }) {
  const nodes = list(b.nodes).map((n): ChangeNode => ({ label: str(n.label), mark: str(n.mark), finding: n.finding ? str(n.finding) : null }));
  return <section style={card}><ChangeList nodes={nodes} /></section>;
}

function Snippet({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      {b.file ? <span style={{ fontSize: 12 }}><FileRefChip text={str(b.file)} fallback={<span className="mr-mono mr-dim">{str(b.file)}</span>} /></span> : null}
      <Diff code={str(b.code)} />
      {b.note ? <span className="mr-ink2">{inline(str(b.note))}</span> : null}
    </section>
  );
}

// Stats: the 2-4 numbers to read first, big (the Doc mockup's hero row).
function Stats({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "flex", flexWrap: "wrap", gap: "12px 32px" }}>
      {list(b.items).map((x, i) => (
        <span key={i} style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <strong className="mr-mono" style={{ fontSize: 26, lineHeight: 1.1 }}>{str(x.value)}</strong>
            <span style={{ fontWeight: 700 }}>{inline(str(x.label))}</span>
          </span>
          {x.detail ? <span className="mr-dim" style={{ fontSize: 12 }}>{inline(str(x.detail))}</span> : null}
        </span>
      ))}
    </section>
  );
}

// Scope: in and out side by side, so the boundary reads in one look.
function Scope({ b }: { b: ViewBlock }) {
  const col = (label: string, items: unknown, tone: "done" | "todo") => (
    <div style={{ flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="mr-dim" style={{ fontSize: 12, fontWeight: 700 }}>{label}</span>
      {(Array.isArray(items) ? items : []).map((x, i) => (
        <span key={i} className="mr-row" style={{ alignItems: "baseline", gap: 8 }}>
          <span style={{ flex: "none", width: 14, display: "inline-flex", justifyContent: "center" }}><Mark tone={tone} /></span>
          <span className={tone === "todo" ? "mr-ink2" : undefined}>{inline(str(x))}</span>
        </span>
      ))}
    </div>
  );
  return (
    <section style={{ ...card, display: "flex", flexWrap: "wrap", gap: 16 }}>
      {col("In", b.in, "done")}
      {Array.isArray(b.out) && b.out.length > 0 && col("Out", b.out, "todo")}
    </section>
  );
}

// Steps: a numbered sequence; the actor column shows who acts, so handoffs stand out.
function Steps({ b }: { b: ViewBlock }) {
  const items = list(b.items);
  const actors = items.some((x) => x.actor);
  return (
    <ol style={{ ...card, margin: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
      {items.map((x, i) => (
        <li key={i} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "5px 0" }}>
          <span className="mr-mono mr-dim" style={{ flex: "none", width: 18, textAlign: "right" }}>{i + 1}</span>
          {actors && <span style={{ flex: "none", width: 72, fontSize: 12, fontWeight: 700, padding: "1px 6px", background: "var(--mr-well)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{str(x.actor)}</span>}
          <span style={{ flex: 1, minWidth: 0 }}>
            {inline(str(x.text))}
            {x.detail ? <span className="mr-dim"> · {inline(str(x.detail))}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

// Risks: each risk beside what contains it; level as bar length, like the severity scale.
const LEVEL: Record<string, { n: number; color: string; name: string }> = {
  high: { n: 3, color: "var(--mr-error)", name: "High" },
  medium: { n: 2, color: "var(--mr-needs-ink)", name: "Medium" },
  low: { n: 1, color: "var(--mr-ink-3)", name: "Low" },
};
function Level({ level }: { level: string }) {
  const l = LEVEL[level.toLowerCase()];
  if (!l) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ display: "inline-flex", gap: 2 }} aria-hidden="true">
        {[1, 2, 3].map((k) => <span key={k} style={{ width: 8, height: 6, borderRadius: 1, background: k <= l.n ? l.color : "var(--mr-lamp-off)" }} />)}
      </span>
      <span style={{ fontSize: 12, fontWeight: 600, color: l.color }}>{l.name}</span>
    </span>
  );
}
function Risks({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) minmax(0, 1fr)", gap: "8px 14px", alignItems: "baseline" }}>
      <span /><span className="mr-dim" style={{ fontSize: 12, fontWeight: 700 }}>Risk</span><span className="mr-dim" style={{ fontSize: 12, fontWeight: 700 }}>Contained by</span>
      {list(b.items).map((x, i) => (
        <Fragment key={i}>
          <span><Level level={str(x.level)} /></span>
          <strong>{inline(str(x.risk))}</strong>
          <span className="mr-ink2">→ {inline(str(x.mitigation))}</span>
        </Fragment>
      ))}
    </section>
  );
}

// Lanes: an architecture as side-by-side zones; the hop between two zones is labelled.
function Lanes({ b }: { b: ViewBlock }) {
  const lanes = list(b.lanes);
  const links = Array.isArray(b.links) ? b.links.map(str) : [];
  const node = (n: unknown) => (typeof n === "object" && n ? { label: str((n as Record<string, unknown>).label), mark: str((n as Record<string, unknown>).mark) } : { label: str(n), mark: "" });
  return (
    <section style={{ ...card, display: "flex", alignItems: "stretch", gap: 0, overflowX: "auto" }}>
      {lanes.map((l, i) => (
        <Fragment key={i}>
          <div style={{ flex: "1 1 0", minWidth: 110, display: "flex", flexDirection: "column", gap: 6, padding: 10, background: "var(--mr-well)" }}>
            <strong style={{ fontSize: 13 }}>{str(l.name)}</strong>
            {(Array.isArray(l.nodes) ? l.nodes : []).map((n, j) => {
              const x = node(n);
              return (
                <span key={j} style={{ padding: "6px 8px", background: "var(--mr-tile)", fontSize: 12 }}>
                  {x.mark && <b className="mr-mono" style={{ color: x.mark === "+" ? "var(--mr-done)" : x.mark === "-" ? "var(--mr-error)" : "var(--mr-ink-2)" }}>{x.mark} </b>}{inline(x.label)}
                </span>
              );
            })}
          </div>
          {i < lanes.length - 1 && (
            <div style={{ flex: "none", width: 64, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 4px", textAlign: "center" }}>
              {links[i] ? <span className="mr-dim" style={{ fontSize: 11 }}>{inline(links[i])}</span> : <span aria-hidden="true" style={{ fontSize: 18 }}>⇄</span>}
            </div>
          )}
        </Fragment>
      ))}
    </section>
  );
}

// Cards: parts or concepts as a scannable grid instead of a bullet list. A mark reads as a
// coloured edge and a word (New / Changed / Removed), not a bare "+"/"~" glyph, and a detail
// listing several things ("check, path choice, swap") splits into chips so it scans.
export const detailParts = (d: string) => d.split(/\s*[,;]\s*/).map((p) => p.trim()).filter(Boolean);
function Cards({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
      {list(b.items).map((x, i) => {
        const title = str(x.title), raw = str(x.mark);
        const m = raw || /^\s*[~+\-−]\s/.test(title) ? MARK[markOf({ label: title, mark: raw })] : null;
        const parts = detailParts(str(x.detail));
        return (
          <div key={i} style={{ padding: "8px 10px 10px 14px", background: "var(--mr-well)", boxShadow: m ? `inset 4px 0 0 ${m.color}` : undefined, display: "flex", flexDirection: "column", gap: 6 }}>
            {m && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: m.color }}>{m.word}</span>}
            <strong style={{ fontSize: 14, lineHeight: 1.3 }}>{inline(changeLabel(title))}</strong>
            {parts.length > 1 ? (
              <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {parts.map((p, j) => <span key={j} className="mr-ink2" style={{ fontSize: 11, padding: "2px 6px", background: "var(--mr-tile)" }}>{inline(p)}</span>)}
              </span>
            ) : parts.length ? <span className="mr-ink2" style={{ fontSize: 12 }}>{inline(parts[0])}</span> : null}
          </div>
        );
      })}
    </section>
  );
}

// Decision: a settled question read as its outcome, and whether it overrode the recommendation.
function Decision({ b }: { b: ViewBlock }) {
  const chosen = str(b.chosen), rec = str(b.recommended);
  const overrode = rec && rec.trim().toLowerCase() !== chosen.trim().toLowerCase();
  const rejected = Array.isArray(b.rejected) ? b.rejected.map(str).filter(Boolean) : [];
  return (
    <section style={{ ...card, boxShadow: "inset 4px 0 0 var(--mr-done)", display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="mr-row" style={{ alignItems: "baseline", gap: 8 }}>
        <Mark tone="done" />
        <strong style={{ fontSize: 17 }}>{inline(chosen)}</strong>
      </span>
      {b.why ? <span className="mr-ink2">{inline(str(b.why))}</span> : null}
      {overrode && <span style={{ fontSize: 12, color: "var(--mr-needs-ink)", fontWeight: 600 }}>Chosen over the recommendation: {inline(rec)}</span>}
      {rejected.length > 0 && <span className="mr-dim" style={{ fontSize: 12 }}>Not chosen: {rejected.map((r, i) => <Fragment key={i}>{i ? " · " : ""}<s>{inline(r)}</s></Fragment>)}</span>}
    </section>
  );
}

// Phases: sequential phases as bars sized by estimate; the hatched tail is the upper bound.
function Phases({ b }: { b: ViewBlock }) {
  const unit = str(b.unit) || "days";
  const items = list(b.items).map((x) => {
    const min = Math.max(0, Number(x.min) || 0);
    return { name: str(x.name), detail: str(x.detail), min, max: Math.max(min, Number(x.max) || min) };
  });
  const total = items.reduce((a, x) => a + x.max, 0) || 1;
  let at = 0;
  const lo = items.reduce((a, x) => a + x.min, 0), hi = items.reduce((a, x) => a + x.max, 0);
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((x, i) => {
        const left = (at / total) * 100;
        at += x.max;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(140px, 30%) 1fr auto", gap: 10, alignItems: "center" }}>
            <span style={{ minWidth: 0 }}><strong>{inline(x.name)}</strong>{x.detail ? <span className="mr-dim" style={{ display: "block", fontSize: 12 }}>{inline(x.detail)}</span> : null}</span>
            <span style={{ position: "relative", height: 12, background: "var(--mr-well)" }} aria-hidden="true">
              <span style={{ position: "absolute", top: 0, bottom: 0, left: `${left}%`, width: `${(x.min / total) * 100}%`, background: "var(--mr-ink-2)" }} />
              {x.max > x.min && <span style={{ position: "absolute", top: 0, bottom: 0, left: `${left + (x.min / total) * 100}%`, width: `${((x.max - x.min) / total) * 100}%`, background: "repeating-linear-gradient(135deg, var(--mr-ink-3) 0 2px, transparent 2px 5px)" }} />}
            </span>
            <span className="mr-mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{x.min === x.max ? x.min : `${x.min}–${x.max}`} {unit}</span>
          </div>
        );
      })}
      <span className="mr-dim" style={{ fontSize: 12, textAlign: "right" }}>Total <b className="mr-mono">{lo === hi ? lo : `${lo}–${hi}`} {unit}</b></span>
    </section>
  );
}

// Matrix: rules or support as a grid; yes / no / partial read as marks.
function Cell({ v }: { v: string }) {
  const k = v.trim().toLowerCase();
  if (k === "yes") return <Mark tone="done" />;
  if (k === "no") return <span className="mr-dim" aria-label="No">–</span>;
  if (k === "partial") return <span style={{ color: "var(--mr-needs-ink)", fontWeight: 700 }} aria-label="Partly">◐</span>;
  return <span className="mr-ink2">{inline(v)}</span>;
}
function Matrix({ b }: { b: ViewBlock }) {
  const cols = list(b.cols).map(str);
  return (
    <section style={{ ...card, overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th />{cols.map((c, i) => <th key={i} className="mr-dim" style={{ textAlign: "center", fontWeight: 600, fontSize: 12, padding: "4px 8px 6px" }}>{c}</th>)}</tr></thead>
        <tbody>
          {list(b.rows).map((r, i) => (
            <tr key={i} style={{ borderTop: "2px solid var(--mr-well)" }}>
              <td style={{ padding: "6px 10px 6px 0", fontWeight: 700 }}>{inline(str(r.label))}</td>
              {cols.map((_, j) => <td key={j} style={{ padding: "6px 8px", textAlign: "center" }}><Cell v={str((Array.isArray(r.cells) ? r.cells : [])[j])} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Suggested next: the proposed move, with one-click replies (only on the latest turn).
function Next({ b, onReply, live }: { b: ViewBlock; onReply: (t: string) => void; live: boolean }) {
  const replies = viewReplies([b]);
  return (
    <div className="mr-row" style={{ ...card, gap: 12, flexWrap: "wrap", padding: "10px 14px" }}>
      <span style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column" }}>
        <span className="mr-dim" style={{ fontSize: 12 }}>Next</span>
        <span>{inline(str(b.text))}</span>
      </span>
      {live && replies.length > 0 && <Chips options={replies} onReply={onReply} />}
    </div>
  );
}

// Severity scale: review findings ranked the same way everywhere. Length = severity.
// SevBars, TierBadge and NoveltyTag are shared with the Review and Address flows.
const SEVERITY: Record<string, { n: number; color: string; name: string }> = {
  critical: { n: 4, color: "var(--mr-error)", name: "Critical" },
  important: { n: 3, color: "var(--mr-needs-ink)", name: "Important" },
  suggestion: { n: 2, color: "var(--mr-ink-2)", name: "Suggestion" },
  nitpick: { n: 1, color: "var(--mr-ink-3)", name: "Nitpick" },
};
export function SevBars({ severity }: { severity: string }) {
  const s = SEVERITY[severity.toLowerCase()] ?? SEVERITY.suggestion;
  return (
    <span style={{ flex: "none", display: "inline-flex", alignItems: "baseline", gap: 10 }}>
      <span style={{ display: "inline-flex", gap: 2, alignSelf: "center" }} aria-hidden="true">
        {[1, 2, 3, 4].map((k) => <span key={k} style={{ width: 10, height: 6, borderRadius: 1, background: k <= s.n ? s.color : "var(--mr-lamp-off)" }} />)}
      </span>
      <span style={{ width: 92, fontWeight: 600, color: s.color }}>{s.name}</span>
    </span>
  );
}
function Findings({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      {list(b.items).map((f, i) => (
        <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <SevBars severity={str(f.severity)} />
          <span className="mr-grow">{inline(str(f.title))}</span>
          {f.where ? <span style={{ flex: "none", fontSize: 11, maxWidth: "45%" }}><FileRefChip text={str(f.where)} fallback={<span className="mr-mono mr-dim">{str(f.where)}</span>} /></span> : null}
        </div>
      ))}
    </section>
  );
}

// Tier badge: what's at stake, before anything else. One line, one tier.
export function TierBadge({ tier, title }: { tier: number; title?: string }) {
  const t = Math.max(1, Math.min(3, Math.round(tier) || 2));
  const badge = t === 1 ? { background: "var(--mr-ink)", color: "var(--mr-base)" } : t === 2 ? { boxShadow: "inset 0 0 0 1px var(--mr-ink)" } : { outline: "1px dashed var(--mr-ink-3)", outlineOffset: -1, color: "var(--mr-ink-2)" };
  return <span title={title} style={{ flex: "none", padding: "2px 8px", fontWeight: 600, ...badge }}>Tier {t}</span>;
}
function Tier({ b }: { b: ViewBlock }) {
  return (
    <div style={{ ...card, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <TierBadge tier={Number(b.tier)} />
      <span style={{ color: Number(b.tier) === 3 ? "var(--mr-ink-2)" : undefined }}>{inline(str(b.label))}</span>
      {b.detail ? <span className="mr-dim">{inline(str(b.detail))}</span> : null}
    </div>
  );
}

// Novelty verdict: "does this already exist?" answered per capability.
const NOVELTY: Record<string, { label: string; style: CSSProperties }> = {
  new: { label: "Net-new", style: { background: "var(--mr-well)", color: "var(--mr-ink-2)" } },
  adjacent: { label: "Adjacent", style: { background: "var(--mr-well)", color: "var(--mr-ink-2)" } },
  overlapping: { label: "Overlapping", style: { background: "var(--mr-needs)", color: "var(--mr-ink)" } },
  duplicate: { label: "Duplicate", style: { background: "color-mix(in srgb, var(--mr-error) 22%, var(--mr-tile))", color: "var(--mr-error)" } },
};
// An unknown verdict shows as written, in the neutral style, rather than being relabelled.
export function NoveltyTag({ verdict }: { verdict: string }) {
  const v = NOVELTY[verdict.trim().toLowerCase().replace(/^net-new$/, "new")] ?? { label: verdict, style: NOVELTY.new.style };
  return <span style={{ flex: "none", minWidth: 92, padding: "1px 8px", fontSize: 11, fontWeight: 600, textAlign: "center", ...v.style }}>{v.label}</span>;
}
function Novelty({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      {list(b.items).map((n, i) => (
        <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <NoveltyTag verdict={str(n.verdict) || "new"} />
          <span className="mr-grow">{inline(str(n.what))}</span>
          {n.where ? <span style={{ flex: "none", fontSize: 11, maxWidth: "45%" }}><FileRefChip text={str(n.where)} fallback={<span className="mr-mono mr-dim">{str(n.where)}</span>} /></span> : null}
        </div>
      ))}
    </section>
  );
}

// Tradeoff slider: when the answer is a number, show what each value costs as you drag.
function Tradeoff({ b, onReply, live }: { b: ViewBlock; onReply: (t: string) => void; live: boolean }) {
  const pts = list(b.points).map((p) => ({ x: Number(p.x), y: Number(p.y) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, c) => a.x - c.x);
  const start = Math.max(0, pts.findIndex((p) => p.x === Number(b.pick)));
  const [i, setI] = useState(start);
  if (pts.length < 2) return null;
  const xu = str(b.x_unit), yu = str(b.y_unit);
  const [x0, x1] = [pts[0].x, pts[pts.length - 1].x];
  const ys = pts.map((p) => p.y);
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const px = (x: number) => ((x - x0) / (x1 - x0 || 1)) * 300;
  const py = (y: number) => 82 - ((y - y0) / (y1 - y0 || 1)) * 74;
  const at = pts[Math.min(i, pts.length - 1)];
  const left = `${(px(at.x) / 300) * 100}%`;
  const value = `${at.x}${xu ? ` ${xu}` : ""}`;
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      {b.label ? <strong>{inline(str(b.label))}</strong> : null}
      <div style={{ position: "relative", height: 90 }}>
        <svg viewBox="0 0 300 90" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <polyline points={pts.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")} fill="none" stroke="var(--mr-ink)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
        <div style={{ position: "absolute", left, top: 0, bottom: 0, borderLeft: "1.5px dashed var(--mr-selected)" }} />
        <span style={{ position: "absolute", left, top: 0, marginLeft: 6, padding: "1px 6px", whiteSpace: "nowrap", fontWeight: 600, color: "var(--mr-selected)", background: "color-mix(in srgb, var(--mr-selected) 18%, var(--mr-tile))", transform: px(at.x) > 200 ? "translateX(calc(-100% - 12px))" : undefined }}>
          {value} → {at.y}{yu ? ` ${yu}` : ""}
        </span>
      </div>
      <div className="mr-row" style={{ gap: 12 }}>
        <input type="range" min={0} max={pts.length - 1} value={i} onChange={(e) => setI(Number(e.target.value))} aria-label={xu || "Value"} className="mr-grow" style={{ accentColor: "var(--mr-selected)" }} />
        {live && <Key onClick={() => onReply(`Use ${value}`)}>Use {value}</Key>}
      </div>
    </section>
  );
}

// Fix options: concrete fixes for one finding, the recommended one first, and a defer.
// Options that carry an `id` keep their order and show it as their key (the Address flow's
// a/b/c answers); `picked` marks the one chosen and `onPick` replaces the default reply.
export type FixOption = { id?: string; label: string; detail?: string; recommended?: boolean };
export function FixOptions({ b, onReply, live, picked, onPick }: { b: ViewBlock; onReply: (t: string) => void; live: boolean; picked?: string; onPick?: (o: FixOption) => void }) {
  const opts = list(b.options).map((o) => ({ id: o.id === undefined ? undefined : str(o.id), label: str(o.label), detail: str(o.detail), recommended: o.recommended === true }));
  const keyed = opts.some((o) => o.id);
  const ordered = keyed ? opts : [...opts.filter((o) => o.recommended), ...opts.filter((o) => !o.recommended)];
  const rows = [...ordered.map((o, k) => ({ ...o, letter: o.id ?? String.fromCharCode(65 + k) })), ...(b.defer === false || keyed ? [] : [{ id: undefined, label: "Defer, with a reply explaining why", detail: "", recommended: false, letter: "" }])];
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 6 }}>
      {b.finding ? <strong style={{ marginBottom: 2 }}>{inline(str(b.finding))}</strong> : null}
      {rows.map((o, k) => {
        const on = picked !== undefined && o.id === picked;
        const text = o.letter && !keyed ? `${o.letter} · ${o.label}` : o.label;
        const pick = () => (onPick ? onPick(o) : onReply(o.letter ? `Go with ${text}` : "Defer this finding and draft a reply explaining why"));
        return (
          <button key={k} type="button" disabled={!live && !on} onClick={() => live && pick()}
            style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "10px 12px", border: 0, textAlign: "left", font: "inherit", cursor: live ? "pointer" : "default",
              background: on ? "var(--mr-ink)" : o.recommended ? "var(--mr-well)" : "transparent", boxShadow: o.recommended && !on ? "inset 0 0 0 1.5px var(--mr-ink)" : undefined, color: on ? "var(--mr-tile)" : o.letter ? "var(--mr-ink)" : "var(--mr-ink-2)" }}>
            {keyed && <kbd className="mr-mono" style={{ flex: "none", padding: "0 6px", background: on ? "transparent" : "var(--mr-well)" }}>{o.letter}</kbd>}
            <span>
              <span style={{ fontWeight: o.recommended || on ? 600 : 400 }}>{inline(text)}</span>
              {o.recommended ? <span style={{ opacity: 0.7 }}> recommended</span> : null}
              {o.detail ? <span style={{ opacity: 0.85 }}> · {inline(o.detail)}</span> : null}
            </span>
          </button>
        );
      })}
    </section>
  );
}

// Thread card: a reviewer comment with its real state. A reply is not a resolution.
// The Address flow adds what happened to it in this session (already, fixed, deferred, open).
const THREAD: Record<string, { label: string; color: string }> = {
  unresolved: { label: "Unresolved", color: "var(--mr-needs-ink)" },
  open: { label: "Not addressed yet", color: "var(--mr-needs-ink)" },
  replied: { label: "Replied · still open", color: "var(--mr-needs-ink)" },
  resolved: { label: "Resolved", color: "var(--mr-done)" },
  already: { label: "Already addressed", color: "var(--mr-done)" },
  fixed: { label: "Fixed in this session", color: "var(--mr-done)" },
  deferred: { label: "Pushed back", color: "var(--mr-ink-3)" },
  picked: { label: "Picked · queued for Claude", color: "var(--mr-ink-2)" },
  fixing: { label: "Claude is fixing this", color: "var(--mr-ink-2)" },
};
export function Thread({ b }: { b: ViewBlock }) {
  const st = THREAD[str(b.state).toLowerCase()] ?? THREAD.unresolved;
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{str(b.author) ? str(b.author).replace(/^@?/, "@") : "Reviewer"}</span>
        {b.where ? <span className="mr-dim">{str(b.where)}</span> : null}
        <span className="mr-grow" />
        <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>
      </div>
      <span style={{ fontSize: 15 }}>{inline(str(b.body))}</span>
      {b.note ? <span className="mr-dim">{inline(str(b.note))}</span> : null}
    </section>
  );
}

function Block({ b, onReply, live, src = "" }: { b: ViewBlock; onReply: (t: string) => void; live: boolean; src?: string }): ReactNode {
  switch (b.type) {
    case "takeaway": return <Takeaway b={b} />;
    case "tally": return <Tally b={b} />;
    case "checklist": return <Checklist b={b} />;
    case "progress": return <Progress b={b} />;
    case "compare": return <Compare b={b} />;
    case "change_graph": return <ChangeGraph b={b} />;
    case "snippet": return <Snippet b={b} />;
    case "next": return <Next b={b} onReply={onReply} live={live} />;
    case "findings": return <Findings b={b} />;
    case "tier": return <Tier b={b} />;
    case "novelty": return <Novelty b={b} />;
    case "tradeoff": return <Tradeoff b={b} onReply={onReply} live={live} />;
    case "fix_options": return <FixOptions b={b} onReply={onReply} live={live} />;
    case "thread": return <Thread b={b} />;
    case "text": return <div style={card}><Markdown text={str(b.markdown)} /></div>;
    case "stats": return <Stats b={b} />;
    case "scope": return <Scope b={b} />;
    case "steps": return <Steps b={b} />;
    case "risks": return <Risks b={b} />;
    case "lanes": return <Lanes b={b} />;
    case "cards": return <Cards b={b} />;
    case "decision": return <Decision b={b} />;
    case "phases": return <Phases b={b} />;
    case "matrix": return <Matrix b={b} />;
    case "images": return <ImageGallery b={b} src={src} onReply={onReply} live={live} />;
    case "image_compare": return <ImageCompare b={b} src={src} onReply={onReply} live={live} />;
    default: return null;
  }
}

// A block in a line, for Block actions: what "go deeper" and "discover" are about.
export function blockGist(b: ViewBlock): string {
  const first = (v: unknown) => list(v).map((x) => str(x.title ?? x.label ?? x.what ?? x.option ?? x.caption ?? x.path)).filter(Boolean).slice(0, 3).join(", ");
  const gist = str(b.heading || b.label || b.finding || b.text || b.file || b.body) || first(b.items) || first(b.options) || first(b.rows) || first(b.nodes) || str(b.markdown) || (b.after ? `before/after ${first([b.before, b.after])}` : "");
  return `${b.type.replace("_", " ")}: ${gist}`.slice(0, 240);
}

// Block actions: on every block, go one level deeper (⌘-click) or explore in a side thread (⌥-click).
function Actions({ b, title, onReply, onDiscover, live }: { b: ViewBlock; title: string; onReply: (t: string) => void; onDiscover?: (what: string) => void; live: boolean }) {
  const gist = blockGist(b);
  return (
    <span className="mr-view-actions" style={{ position: "absolute", top: 6, right: 8, display: "flex", gap: 4 }}>
      {b.type === "text" && str(b.markdown) && <CopyKey text={str(b.markdown)} style={{ opacity: 1 }} />}
      {live && <Key onClick={() => onReply(`Go one level deeper on "${gist}"`)}>↘ Deeper</Key>}
      {onDiscover && <Key onClick={() => onDiscover(`the "${title}" view, ${gist}`)}>⌕ Discover</Key>}
    </span>
  );
}

// Blocks that draw nothing clickable without live replies, so they can sit inside a doc tile's button.
const GLANCE = new Set(["decision", "stats", "scope", "steps", "risks", "lanes", "cards", "phases", "matrix", "takeaway", "tally", "checklist", "progress", "compare", "change_graph", "findings", "tier", "novelty", "snippet", "thread"]);

// A doc tile's glance at its view (MR-100): the first block that reads at a glance, not interactive.
export function ViewGlance({ blocks, source }: { blocks: ViewBlock[]; source: string }) {
  const b = blocks.find((x) => GLANCE.has(x.type));
  if (!b) return null;
  return (
    <span data-mr={`View:${b.type}`} data-mr-source={source} data-mr-layer="model" aria-hidden="true"
      style={{ display: "block", maxHeight: 200, overflow: "hidden", pointerEvents: "none", fontSize: 13, background: "var(--mr-well)", padding: 2 }}>
      <Block b={b} onReply={() => {}} live={false} />
    </span>
  );
}

// The replies a view's Suggested next offers: Focus binds them to ⌥1–3.
export function viewReplies(blocks: ViewBlock[]): string[] {
  const next = [...blocks].reverse().find((b) => b.type === "next");
  return next ? list(next.replies).map(str).filter(Boolean).slice(0, 3) : [];
}

export function CatalogView({ id, title, blocks, onReply, onDiscover, live }: { id: string; title: string; blocks: ViewBlock[]; onReply: (t: string) => void; onDiscover?: (what: string) => void; live: boolean }) {
  return (
    <div data-mr="CatalogView" data-mr-source={id} data-mr-layer="model" style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
      {title && <strong style={{ fontSize: 17, padding: "4px 2px 0" }}>{title}</strong>}
      {blocks.map((b, i) => {
        // Pointing on a block (decision 21): ⌘-click goes deeper, ⌥-click discovers. Next and text have no depth.
        const actionable = b.type !== "next" && b.type !== "text";
        const point = actionable ? pointer({ deeper: live ? () => onReply(`Go one level deeper on "${blockGist(b)}"`) : undefined, discover: onDiscover && (() => onDiscover(`the "${title}" view, ${blockGist(b)}`)) }) : undefined;
        return (
          <div key={i} data-mr={`View:${b.type}`} data-mr-source={`${id}:${i}`} className="mr-view-block" style={{ position: "relative" }} onClickCapture={(e) => { if (point && (modKey(e) || e.altKey)) point(e); }}>
            <Block b={b} onReply={onReply} live={live} src={`${id}:${i}`} />
            {actionable && <Actions b={b} title={title} onReply={onReply} onDiscover={onDiscover} live={live} />}
          </div>
        );
      })}
    </div>
  );
}
