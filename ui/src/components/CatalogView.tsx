import type { ReactNode } from "react";
import { ProgressTrack, type Seg } from ".";
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
    case "text": return <div style={card}><Markdown text={str(b.markdown)} /></div>;
    default: return null;
  }
}

// The replies a view's Suggested next offers: Focus binds them to ⌥1–3.
export function viewReplies(blocks: ViewBlock[]): string[] {
  const next = [...blocks].reverse().find((b) => b.type === "next");
  return next ? list(next.replies).map(str).filter(Boolean).slice(0, 3) : [];
}

export function CatalogView({ id, title, blocks, onReply, live }: { id: string; title: string; blocks: ViewBlock[]; onReply: (t: string) => void; live: boolean }) {
  return (
    <div data-mr="CatalogView" data-mr-source={id} data-mr-layer="model" style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
      {title && <strong style={{ fontSize: 17, padding: "4px 2px 0" }}>{title}</strong>}
      {blocks.map((b, i) => <div key={i} data-mr={`View:${b.type}`} data-mr-source={`${id}:${i}`}><Block b={b} onReply={onReply} live={live} /></div>)}
    </div>
  );
}
