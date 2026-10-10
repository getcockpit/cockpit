import { useState } from "react";
import { Diff } from "./Diff";
import { Mark } from "./Turn";
import { pointer } from "./pointer";
import { checkRow, type EditCard } from "../picker/logCards";
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
