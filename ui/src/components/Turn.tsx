import type { ReactNode } from "react";
import { Markdown, inline } from "./Markdown";
import { CopyKey } from "./CopyKey";
import { keyLabel } from "../platform";
import { proposedReplies, replyOptions, withoutReplyLine } from "../picker/queue";
import { parseReport, type Item, type Report, type Section } from "../picker/report";
export { parseReport };

// How an assistant turn is shown (MR-56). Plain replies render as Markdown. Report-shaped replies
// (sections + lists, e.g. "where things stand / do now / only you can do / Next: …") render as
// the canvas components: a decision card for the lead question, takeaway-style section blocks
// with checklist rows (state marks, time chips), and Suggested next with quick-reply chips.
// No model involved: this is plain parsing of the Markdown Claude is asked to write.

// State marks from the canvas: shape and colour together.
export function Mark({ tone, done }: { tone: Section["tone"]; done?: boolean }) {
  if (done || tone === "done") return <svg width="12" height="12" viewBox="0 0 12 12" aria-label="Done" role="img"><path d="M2 6.3 4.8 9 10 3" fill="none" stroke="var(--mr-done)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (tone === "you") return <svg width="12" height="12" viewBox="0 0 14 14" aria-label="Needs you" role="img"><path d="M7 1.5 13 12.5H1Z" fill="var(--mr-needs)" /></svg>;
  if (tone === "todo") return <svg width="12" height="12" viewBox="0 0 12 12" aria-label="To do" role="img"><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--mr-ink-3)" strokeWidth="1.5" /></svg>;
  return <span aria-hidden style={{ width: 12, textAlign: "center", color: "var(--mr-ink-3)" }}>·</span>;
}

function ItemRow({ it, tone, n }: { it: Item; tone: Section["tone"]; n: number | null }) {
  // "Done: x, y" / "Not started: z" lines inside a status section carry their own state.
  const doneLine = /^done\b/i.test(it.title ?? "");
  const openLine = /^(not started|todo|missing|blocked)/i.test(it.title ?? "");
  const itemTone = doneLine ? "done" : openLine ? "todo" : tone;
  return (
    <div data-mr="ReportItem" style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "6px 0" }}>
      <span style={{ flex: "none", width: 14, display: "inline-flex", justifyContent: "center", transform: "translateY(1px)" }}><Mark tone={itemTone} /></span>
      {n !== null && <span className="mr-mono mr-dim" style={{ flex: "none", fontSize: 11, width: 14 }}>{n}</span>}
      <span style={{ flex: 1, minWidth: 0 }}>
        {it.title && <strong>{inline(it.title)}{it.detail ? " " : ""}</strong>}
        <span className={it.title ? "mr-ink2" : undefined}>{inline(it.detail)}</span>
        {it.sub.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{it.sub.map((x, i) => <li key={i} className="mr-ink2">{inline(x)}</li>)}</ul>}
      </span>
      {it.time && <span className="mr-mono" style={{ flex: "none", fontSize: 11, padding: "1px 6px", background: "var(--mr-well)", color: "var(--mr-ink-2)" }}>{it.time}</span>}
    </div>
  );
}

const KICKER: Record<Section["tone"], string> = { done: "Status", todo: "To do", you: "Needs you", info: "" };

export function ReportView({ r, onReply, live }: { r: Report; onReply: (text: string) => void; live: boolean }) {
  const proposed = r.next ? proposedReplies(`Next: ${r.next}`) : [];
  const nextOptions = proposed.length ? proposed : r.next ? replyOptions(r.next) : [];
  // A Next line that only lists replies shows as its buttons, not as text too.
  const nextText = r.next && withoutReplyLine(`Next: ${r.next}`) === "" ? null : r.next;
  const decisionOptions = r.decision ? replyOptions(`${r.decision} ${r.next ?? ""}`) : [];
  const chips = nextOptions.length ? nextOptions : decisionOptions;
  return (
    <div data-mr="Report" style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
      {r.decision && (
        // Decision card: the one ask this turn is waiting on, with its quick replies.
        <div data-mr="ReportDecision" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px", background: "var(--mr-tile)", boxShadow: "inset 4px 0 0 var(--mr-needs)" }}>
          <span className="mr-row" style={{ gap: 6, color: "var(--mr-needs-ink)", fontWeight: 600 }}><Mark tone="you" />Decide</span>
          <strong style={{ fontSize: 18, lineHeight: 1.25 }}>{r.decision}</strong>
          {r.lead.map((p, i) => <span key={i} className="mr-ink2">{inline(p)}</span>)}
          {live && chips.length > 0 && <Chips options={chips} onReply={onReply} />}
        </div>
      )}
      {!r.decision && r.lead.length > 0 && <div style={{ padding: "12px 14px", background: "var(--mr-tile)" }}><Markdown text={r.lead.join("\n")} /></div>}
      {r.sections.map((s, i) => (
        // Takeaway block: section · status, then its rows.
        <section key={i} data-mr="ReportSection" data-mr-source={s.heading} style={{ padding: "12px 16px", background: "var(--mr-tile)", boxShadow: s.tone === "you" ? "inset 4px 0 0 var(--mr-needs)" : undefined }}>
          <div className="mr-row" style={{ gap: 8, marginBottom: s.items.length ? 4 : 0 }}>
            {KICKER[s.tone] && <span className="mr-dim" style={{ fontSize: 12 }}>{KICKER[s.tone]} ·</span>}
            <strong style={{ fontSize: 15 }}>{s.heading}</strong>
            {s.items.length > 1 && <span className="mr-mono mr-dim" style={{ fontSize: 11 }}>{s.items.length}</span>}
          </div>
          {s.intro.length > 0 && <div className="mr-ink2" style={{ margin: "2px 0 6px" }}><Markdown text={s.intro.join("\n")} /></div>}
          {s.items.map((it, j) => <ItemRow key={j} it={it} tone={s.tone} n={s.ordered ? j + 1 : null} />)}
          {s.outro.length > 0 && <div className="mr-ink2" style={{ margin: "6px 0 2px" }}><Markdown text={s.outro.join("\n")} /></div>}
        </section>
      ))}
      {r.next && (nextText || (live && chips.length > 0)) && (
        // Suggested next: the move this turn proposes, as one-click replies.
        <div data-mr="ReportNext" className="mr-row" style={{ gap: 12, padding: "10px 14px", background: "var(--mr-tile)", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column" }}>
            <span className="mr-dim" style={{ fontSize: 12 }}>Next</span>
            {nextText && <span>{inline(nextText)}</span>}
          </span>
          {live && chips.length > 0 && <Chips options={chips} onReply={onReply} />}
        </div>
      )}
    </div>
  );
}

// Quick-reply chips from the canvas: 2–4 answers, one key each.
export function Chips({ options, onReply }: { options: string[]; onReply: (t: string) => void }) {
  return (
    <div className="mr-row" style={{ gap: 8, flexWrap: "wrap" }} data-mr="QuickReplies">
      {options.map((o, i) => (
        <button key={o} type="button" className="mr-key" data-tone={i === 0 ? "primary" : undefined} onClick={() => onReply(o)}>
          {o} <kbd>{keyLabel(`⌥${i + 1}`)}</kbd>
        </button>
      ))}
    </div>
  );
}

/** One assistant turn: a report when it's shaped like one, Markdown otherwise. A Copy button for
 *  its Markdown sits top right, next to any `actions` the caller adds. */
export function TurnText({ text, onReply, live, actions }: { text: string; onReply: (t: string) => void; live: boolean; actions?: ReactNode }): ReactNode {
  const r = parseReport(text);
  return (
    <div className="mr-copyable" style={{ position: "relative" }}>
      {r ? <ReportView r={r} onReply={onReply} live={live} />
        // Proposed replies show as buttons under the turn, so their bare Next line isn't repeated here.
        : <div style={{ padding: "12px 14px", background: "var(--mr-tile)" }}><Markdown text={withoutReplyLine(text)} /></div>}
      <span className="mr-row" style={{ position: "absolute", top: 6, right: 8, gap: 4 }}><CopyKey text={text} />{actions}</span>
    </div>
  );
}
