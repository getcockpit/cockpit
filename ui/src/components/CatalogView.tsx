import { useState, type CSSProperties, type ReactNode } from "react";
import { Key, ProgressTrack, type Seg } from ".";
import { pointer } from "./pointer";
import { Diff } from "./Diff";
import { Markdown, inline } from "./Markdown";
import { Chips, Mark } from "./Turn";
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
function Tally({ b }: { b: ViewBlock }) {
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
function Checklist({ b }: { b: ViewBlock }) {
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

// Change graph: what a change touches, + new, ~ changed, − removed.
function ChangeGraph({ b }: { b: ViewBlock }) {
  const nodes = list(b.nodes);
  return (
    <section style={{ ...card, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {nodes.map((n, i) => {
        const mark = str(n.mark) || "~";
        return (
          <span key={i} className="mr-row" style={{ gap: 6 }}>
            <span style={{ padding: "6px 10px", background: "var(--mr-well)", fontSize: 12 }}>
              <b className="mr-mono" style={{ color: mark === "+" ? "var(--mr-done)" : mark === "-" ? "var(--mr-error)" : "var(--mr-ink-2)" }}>{mark}</b> {str(n.label)}
            </span>
            {i < nodes.length - 1 && <span className="mr-dim">→</span>}
          </span>
        );
      })}
    </section>
  );
}

function Snippet({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      {b.file ? <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{str(b.file)}</span> : null}
      <Diff code={str(b.code)} />
      {b.note ? <span className="mr-ink2">{inline(str(b.note))}</span> : null}
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
const SEVERITY: Record<string, { n: number; color: string; name: string }> = {
  critical: { n: 4, color: "var(--mr-error)", name: "Critical" },
  important: { n: 3, color: "var(--mr-needs-ink)", name: "Important" },
  suggestion: { n: 2, color: "var(--mr-ink-2)", name: "Suggestion" },
  nitpick: { n: 1, color: "var(--mr-ink-3)", name: "Nitpick" },
};
function Findings({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      {list(b.items).map((f, i) => {
        const s = SEVERITY[str(f.severity).toLowerCase()] ?? SEVERITY.suggestion;
        return (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ flex: "none", display: "inline-flex", gap: 2, alignSelf: "center" }} aria-hidden="true">
              {[1, 2, 3, 4].map((k) => <span key={k} style={{ width: 10, height: 6, borderRadius: 1, background: k <= s.n ? s.color : "var(--mr-band)" }} />)}
            </span>
            <span style={{ flex: "none", width: 92, fontWeight: 600, color: s.color }}>{s.name}</span>
            <span className="mr-grow">{inline(str(f.title))}</span>
            {f.where ? <span className="mr-mono mr-dim" style={{ flex: "none", fontSize: 11 }}>{str(f.where)}</span> : null}
          </div>
        );
      })}
    </section>
  );
}

// Tier badge: what's at stake, before anything else. One line, one tier.
function Tier({ b }: { b: ViewBlock }) {
  const tier = Math.max(1, Math.min(3, Math.round(Number(b.tier)) || 2));
  const badge = tier === 1 ? { background: "var(--mr-ink)", color: "var(--mr-base)" } : tier === 2 ? { boxShadow: "inset 0 0 0 1px var(--mr-ink)" } : { outline: "1px dashed var(--mr-ink-3)", outlineOffset: -1, color: "var(--mr-ink-2)" };
  return (
    <div style={{ ...card, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <span style={{ padding: "2px 8px", fontWeight: 600, ...badge }}>Tier {tier}</span>
      <span style={{ color: tier === 3 ? "var(--mr-ink-2)" : undefined }}>{inline(str(b.label))}</span>
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
function Novelty({ b }: { b: ViewBlock }) {
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      {list(b.items).map((n, i) => {
        const v = NOVELTY[str(n.verdict).toLowerCase().replace("net-new", "new")] ?? NOVELTY.new;
        return (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ flex: "none", width: 92, padding: "1px 8px", fontSize: 11, fontWeight: 600, textAlign: "center", ...v.style }}>{v.label}</span>
            <span className="mr-grow">{inline(str(n.what))}</span>
            {n.where ? <span className="mr-mono mr-dim" style={{ flex: "none", fontSize: 11 }}>{str(n.where)}</span> : null}
          </div>
        );
      })}
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
function FixOptions({ b, onReply, live }: { b: ViewBlock; onReply: (t: string) => void; live: boolean }) {
  const opts = list(b.options).map((o) => ({ label: str(o.label), detail: str(o.detail), rec: o.recommended === true }));
  const ordered = [...opts.filter((o) => o.rec), ...opts.filter((o) => !o.rec)];
  const rows = [...ordered.map((o, k) => ({ ...o, letter: String.fromCharCode(65 + k) })), ...(b.defer === false ? [] : [{ label: "Defer, with a reply explaining why", detail: "", rec: false, letter: "" }])];
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 6 }}>
      {b.finding ? <strong style={{ marginBottom: 2 }}>{inline(str(b.finding))}</strong> : null}
      {rows.map((o, k) => {
        const text = o.letter ? `${o.letter} · ${o.label}` : o.label;
        return (
          <button key={k} type="button" disabled={!live} onClick={() => onReply(o.letter ? `Go with ${text}` : "Defer this finding and draft a reply explaining why")}
            style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "10px 12px", border: 0, textAlign: "left", font: "inherit", cursor: live ? "pointer" : "default",
              background: o.rec ? "var(--mr-well)" : "transparent", boxShadow: o.rec ? "inset 0 0 0 1.5px var(--mr-ink)" : undefined, color: o.letter ? "var(--mr-ink)" : "var(--mr-ink-2)" }}>
            <span>
              <span style={{ fontWeight: o.rec ? 600 : 400 }}>{inline(text)}</span>
              {o.rec ? <span className="mr-dim"> recommended</span> : null}
              {o.detail ? <span className="mr-ink2"> · {inline(o.detail)}</span> : null}
            </span>
          </button>
        );
      })}
    </section>
  );
}

// Thread card: a reviewer comment with its real state. A reply is not a resolution.
const THREAD: Record<string, { label: string; color: string }> = {
  unresolved: { label: "Unresolved", color: "var(--mr-needs-ink)" },
  replied: { label: "Replied · still open", color: "var(--mr-needs-ink)" },
  resolved: { label: "Resolved", color: "var(--mr-done)" },
};
function Thread({ b }: { b: ViewBlock }) {
  const st = THREAD[str(b.state).toLowerCase()] ?? THREAD.unresolved;
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{str(b.author).replace(/^@?/, "@")}</span>
        {b.where ? <span className="mr-dim">{str(b.where)}</span> : null}
        <span className="mr-grow" />
        <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>
      </div>
      <span>{inline(str(b.body))}</span>
      {b.note ? <span className="mr-dim">{inline(str(b.note))}</span> : null}
    </section>
  );
}

function Block({ b, onReply, live }: { b: ViewBlock; onReply: (t: string) => void; live: boolean }): ReactNode {
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
    default: return null;
  }
}

// A block in a line, for Block actions: what "go deeper" and "discover" are about.
export function blockGist(b: ViewBlock): string {
  const first = (v: unknown) => list(v).map((x) => str(x.title ?? x.label ?? x.what ?? x.option)).filter(Boolean).slice(0, 3).join(", ");
  const gist = str(b.heading || b.label || b.finding || b.text || b.file || b.body) || first(b.items) || first(b.options) || first(b.rows) || first(b.nodes) || str(b.markdown);
  return `${b.type.replace("_", " ")}: ${gist}`.slice(0, 240);
}

// Block actions: on every block, go one level deeper (⌘-click) or explore in a side thread (⌥-click).
function Actions({ b, title, onReply, onDiscover, live }: { b: ViewBlock; title: string; onReply: (t: string) => void; onDiscover?: (what: string) => void; live: boolean }) {
  const gist = blockGist(b);
  return (
    <span className="mr-view-actions" style={{ position: "absolute", top: 6, right: 8, display: "flex", gap: 4 }}>
      {live && <Key onClick={() => onReply(`Go one level deeper on "${gist}"`)}>↘ Deeper</Key>}
      {onDiscover && <Key onClick={() => onDiscover(`the "${title}" view, ${gist}`)}>⌕ Discover</Key>}
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
          <div key={i} data-mr={`View:${b.type}`} data-mr-source={`${id}:${i}`} className="mr-view-block" style={{ position: "relative" }} onClickCapture={(e) => { if (point && (e.metaKey || e.altKey)) point(e); }}>
            <Block b={b} onReply={onReply} live={live} />
            {actionable && <Actions b={b} title={title} onReply={onReply} onDiscover={onDiscover} live={live} />}
          </div>
        );
      })}
    </div>
  );
}
