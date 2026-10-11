import { useState } from "react";
import { Diff } from "./Diff";
import { Mark } from "./Turn";
import { pointer } from "./pointer";
import { checkRow, stepSummary, type EditCard, type StepTally } from "../picker/logCards";
import type { TranscriptItem } from "../state/types";

// Task log cards (MR-75): a file edit as a Snippet card, a run of checks as a Verification checklist.
type Tool = Extract<TranscriptItem, { kind: "tool" }>;
const PREVIEW = 12;

export function EditSnippet({ t, c, onDiscover }: { t: Tool; c: EditCard; onDiscover: (what: string) => void }) {
  const [open, setOpen] = useState(false);
  const lines = c.code.split("\n");
  const long = lines.length > PREVIEW;
  const shown = open || !long ? c.code : lines.slice(0, PREVIEW).join("\n");
  const hidden = (open ? 0 : lines.length - PREVIEW) + c.more;
  return (
    <section data-mr="EditSnippet" data-mr-source={t.toolUseId} style={{ background: "var(--mr-tile)" }}>
      <button type="button" onClick={pointer({ open: () => setOpen((x) => !x), deeper: () => setOpen(true), discover: () => onDiscover(`the edit to ${c.path}`) })} className="mr-row" style={{ width: "100%", padding: "8px 14px", border: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: long ? "pointer" : "default", gap: 10 }}>
        <span className="mr-mono mr-ellipsis" style={{ fontWeight: 700 }} title={c.path}>{c.file}</span>
        {c.where && <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{c.where}</span>}
        <span className="mr-grow" />
        <span className="mr-mono" style={{ fontSize: 12 }}>
          {c.added > 0 && <span style={{ color: "var(--mr-done)" }}>+{c.added}</span>}
          {c.added > 0 && c.removed > 0 && " "}
          {c.removed > 0 && <span style={{ color: "var(--mr-error)" }}>−{c.removed}</span>}
        </span>
        {t.result === undefined && <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>…</span>}
      </button>
      <div style={{ padding: "0 14px 10px" }}>
        <Diff code={shown} />
        {hidden > 0 && (
          <button type="button" onClick={() => setOpen(true)} className="mr-mono mr-dim" style={{ border: 0, background: "transparent", font: "inherit", fontSize: 12, padding: "4px 0 0", cursor: "pointer", color: "var(--mr-ink-3)" }}>
            {open ? `${c.more} more lines not shown` : `Show ${hidden} more lines`}
          </button>
        )}
      </div>
    </section>
  );
}

export function CheckList({ tools }: { tools: Tool[] }) {
  return (
    <section data-mr="CheckList" data-mr-source={tools[0].toolUseId} style={{ padding: "10px 14px", background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 6 }}>
      {tools.map((t) => {
        const r = checkRow(t);
        return (
          <div key={t.id} data-mr="CheckRow" data-mr-source={t.toolUseId} className="mr-row" style={{ alignItems: "baseline", gap: 10 }}>
            <span style={{ width: 14, display: "inline-flex", justifyContent: "center" }}>
              {r.ok === true ? <Mark tone="done" /> : r.ok === false ? <span style={{ color: "var(--mr-error)", fontWeight: 700 }} aria-label="Failed">✕</span> : <Mark tone="todo" />}
            </span>
            <span className="mr-grow mr-ellipsis" title={String(t.input.command ?? "")}>{r.label}</span>
            <span className="mr-mono mr-ellipsis" style={{ fontSize: 11, maxWidth: "45%", color: r.ok === false ? "var(--mr-error)" : "var(--mr-ink-3)" }}>{r.proof}</span>
          </div>
        );
      })}
    </section>
  );
}

// A plan step at a glance (MR-76): a Tally bar of its actions, then the files it touched as
// Change graph chips (+ new, ~ edited) with their line counts.
const TONE: Record<StepTally["tone"], string> = { done: "var(--mr-done)", now: "var(--mr-ink)", deferred: "var(--mr-ink-3)", todo: "var(--mr-well)", error: "var(--mr-error)" };

export function StepSummary({ tools, source }: { tools: Tool[]; source: string }) {
  const { tally, files } = stepSummary(tools);
  // A bar for one or two actions of one kind only repeats the rows under it.
  const total = tally.reduce((n, x) => n + x.n, 0);
  if (tally.length < 2 && total < 3) return null;
  return (
    <div data-mr="StepSummary" data-mr-source={source} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 14px 10px 38px" }}>
      <div style={{ display: "flex", height: 6, gap: 2 }} aria-hidden="true">
        {tally.map((x) => <span key={x.label} style={{ flex: `${x.n} 1 0`, background: TONE[x.tone] }} />)}
      </div>
      <div className="mr-ink2" style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", fontSize: 12 }}>
        {tally.map((x) => <span key={x.label}><strong style={{ color: x.tone === "todo" ? "var(--mr-ink-2)" : TONE[x.tone] }}>{x.n}</strong> {x.label}</span>)}
      </div>
      {files.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {files.map((f) => (
            <span key={f.path} title={f.path} className="mr-mono" style={{ padding: "4px 8px", background: "var(--mr-well)", fontSize: 12 }}>
              <b style={{ color: f.mark === "+" ? "var(--mr-done)" : "var(--mr-ink-2)" }}>{f.mark}</b> {f.label}
              <span className="mr-dim"> {f.added > 0 && `+${f.added}`}{f.added > 0 && f.removed > 0 && " "}{f.removed > 0 && `−${f.removed}`}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
