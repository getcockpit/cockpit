import { useState, type ReactNode } from "react";
import type { DecisionSpec, Risk, TileSpec } from "../picker/pick";
import type { Delivery } from "../state/types";

// The component catalog (decision 16). Screens are composed only from these.

export function Lamps({ children }: { children: ReactNode }) {
  const n = Array.isArray(children) ? children.length : 1;
  return <section aria-label="Status lamps" className="mr-lamps" style={{ ["--n" as string]: n }}>{children}</section>;
}

export function Lamp({ value, label, on, onClick }: { value: string | number; label: string; on?: "needs" | "error" | "plain" | false; onClick?: () => void }) {
  const body = <><b>{value}</b><span>{label}</span></>;
  return onClick
    ? <button type="button" className="mr-lamp" data-mr="Lamp" data-mr-source={label} data-on={on || undefined} onClick={onClick} aria-label={`${value} ${label}`} style={{ border: 0, font: "inherit", cursor: "pointer" }}>{body}</button>
    : <div className="mr-lamp" data-mr="Lamp" data-mr-source={label} data-on={on || undefined}>{body}</div>;
}

export function Key({ k, children, tone, onClick, disabled, submit }: { k?: string; children: ReactNode; tone?: "primary" | "needs"; onClick?: () => void; disabled?: boolean; submit?: boolean }) {
  return (
    <button type={submit ? "submit" : "button"} className="mr-key" data-tone={tone} onClick={onClick} disabled={disabled}>
      {k && <kbd>{k}</kbd>}
      {children}
    </button>
  );
}

const GLYPH: Record<TileSpec["state"], string> = { needs_you: "◆", working: "○", almost: "◔", idle: "‖", done: "✓", error: "✕", starting: "…", interrupted: "■" };
const LABEL: Record<TileSpec["state"], string> = { needs_you: "Needs you", working: "Working", almost: "Almost done", idle: "Waiting", done: "Done", error: "Error", starting: "Starting", interrupted: "Interrupted" };

export function StateMark({ s }: { s: TileSpec["state"] }) {
  return <span className="mr-mark" data-s={s}><span aria-hidden="true">{GLYPH[s]}</span>{LABEL[s]}</span>;
}

// Progress track (canvas: Glance): where you are and how much is left, as one segment per step.
// `live` pulses the current segment while Claude works; `stale` turns it amber when Claude goes quiet.
export type Seg = "done" | "current" | "todo";
// `fill` draws one continuous bar (done share filled, the current step pulsing after it) for the
// higher levels, header and tiles, where "how far along" matters more than the step count (MR-63).
// `pct` is the headline: a large figure at the end of the bar, in the same place on every tile, so
// "how far along" reads first; the step and timer stay a quiet caption below.
export function ProgressTrack({ segs, left, right, live, stale, source, fill, pct }: { segs: Seg[]; left: ReactNode; right?: ReactNode; live?: boolean; stale?: boolean; source?: string; fill?: boolean; pct?: number | null }) {
  const n = Math.max(1, segs.length), done = segs.filter((s) => s === "done").length, cur = segs.includes("current") ? 1 : 0;
  const bar = fill
    ? <div className="mr-track-fill" aria-hidden="true"><i data-seg="done" style={{ width: `${(done / n) * 100}%` }} /><i data-seg="current" style={{ width: `${(cur / n) * 100}%` }} /></div>
    : <div className="mr-track-segs" aria-hidden="true">{segs.map((s, i) => <i key={i} data-seg={s} />)}</div>;
  return (
    <div className="mr-track" data-mr="ProgressTrack" data-mr-source={source} data-live={live || undefined} data-stale={stale || undefined} data-fill={fill || undefined} role="progressbar" aria-valuenow={Math.round((done / n) * 100)}>
      {pct != null ? <div className="mr-track-bar">{bar}<b className="mr-track-pct">{pct}%</b></div> : bar}
      <div className="mr-track-cap"><span className="mr-ellipsis">{left}</span>{right && <span className="mr-track-right">{right}</span>}</div>
    </div>
  );
}

// State marks for a message you sent (MR-59): same shape-plus-colour language as session states.
const DGLYPH: Record<Delivery, string> = { sending: "…", queued: "◷", taken: "○", answered: "✓", lost: "✕" };
const DLABEL: Record<Delivery, string> = { sending: "Sending", queued: "Queued · after this step", taken: "Claude has it", answered: "Answered", lost: "Not delivered" };
const DTITLE: Record<Delivery, string> = { sending: "Handing it to Claude", queued: "Claude is mid-step: it reads this at its next step", taken: "Claude is working on this", answered: "Its turn finished", lost: "The session stopped before Claude read this: send it again" };
export function DeliveryMark({ d, source }: { d: Delivery; source: string }) {
  return <span className="mr-mark" data-mr="DeliveryMark" data-mr-source={source} data-d={d} title={DTITLE[d]}><span aria-hidden="true">{DGLYPH[d]}</span>{DLABEL[d]}</span>;
}

export function Bar({ value, tone }: { value: number | null; tone?: "needs" }) {
  return <div className="mr-bar" data-tone={tone} role="progressbar" aria-valuenow={value === null ? undefined : Math.round(value * 100)}><i style={{ width: `${Math.round((value ?? 0) * 100)}%` }} /></div>;
}

export function RiskMeter({ risk, why }: { risk: Risk; why: string }) {
  return (
    <span className="mr-risk" data-r={risk} title={why}>
      <b style={{ color: risk === "high" ? "var(--mr-error)" : risk === "medium" ? "var(--mr-needs-ink)" : "var(--mr-ink-2)" }}>{risk[0].toUpperCase() + risk.slice(1)} risk</b>
      <i /><i /><i />
      <span className="mr-dim">{why}</span>
    </span>
  );
}

export function Sparkline({ values, w = 96, h = 24 }: { values: number[]; w?: number; h?: number }) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i * w) / Math.max(1, values.length - 1)).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Activity, last 30 minutes"><polyline points={pts} fill="none" stroke="var(--mr-ink-3)" strokeWidth="1.25" /></svg>;
}

export type Answer =
  | { kind: "allow"; always?: boolean }
  | { kind: "deny"; note?: string }
  | { kind: "answer"; answers: Record<string, string> };

// When none of the options fit (I75): what Claude is told for each way out of a question.
export const ASK_FIRST = "None of these options fit. Before offering options again, ask me 1-3 short clarifying questions in plain text and wait for my reply; then ask again with better options.";
export const SKIPPED = "I skipped this question: none of the options fit. Don't ask it again. Carry on with your best judgment and say in one line what you assumed, or stop if you can't go on without it.";

/** The way out of a question card: Claude gets the user's own words, a request to ask first, or a skip. */
export function wayOut(questions: { question: string }[], x: { kind: "reply"; text: string } | { kind: "ask_first" } | { kind: "skip" }): Answer {
  if (x.kind === "ask_first") return { kind: "deny", note: ASK_FIRST };
  if (x.kind === "skip") return { kind: "deny", note: SKIPPED };
  // One question: the reply is its answer, like Claude Code's own "Other". Several: it goes back as a note.
  return questions.length === 1 ? { kind: "answer", answers: { [questions[0].question]: x.text } } : { kind: "deny", note: `None of the options fit. My answer: ${x.text}` };
}

// One card for every decision; the body depends on the picked spec.
export function DecisionCard({ spec, onAnswer }: { spec: DecisionSpec; onAnswer: (a: Answer) => void }) {
  if (spec.component === "QuestionCard") return <QuestionCard questions={spec.questions} onAnswer={onAnswer} />;
  const title = spec.component === "CommandCard" ? (spec.description || "Run a command")
    : spec.component === "DiffCard" ? `${spec.tool === "Write" ? "Create" : "Edit"} ${spec.path.split("/").pop()}`
    : `Use ${spec.tool}`;
  const body = spec.component === "CommandCard" ? spec.command : spec.component === "DiffCard" ? spec.preview : spec.summary;
  return (
    <>
      <span className="mr-ask">{title}</span>
      {spec.component === "DiffCard" && <span className="mr-mono mr-dim">{spec.path} · +{spec.added} −{spec.removed}</span>}
      {body && <pre className="mr-code">{body}</pre>}
      <RiskMeter risk={spec.risk} why={spec.why} />
      <div className="mr-row" style={{ flexWrap: "wrap" }}>
        <Key k="A" tone="needs" onClick={() => onAnswer({ kind: "allow" })}>Allow</Key>
        <Key k="S" onClick={() => onAnswer({ kind: "allow", always: true })}>Allow for this session</Key>
        <Key k="D" onClick={() => onAnswer({ kind: "deny" })}>Deny</Key>
      </div>
    </>
  );
}

// A question with its options, plus a way out when none fit: answer in your own words, have Claude
// ask you first, or skip it.
function QuestionCard({ questions, onAnswer }: { questions: Extract<DecisionSpec, { component: "QuestionCard" }>["questions"]; onAnswer: (a: Answer) => void }) {
  return (
    <div className="mr-queue" style={{ gap: 12 }}>
      {questions.map((q, qi) => (
        <div key={qi} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="mr-ask">{q.question}</span>
          <div className="mr-row" style={{ flexWrap: "wrap" }}>
            {q.options.map((o, oi) => (
              <Key key={oi} k={String(oi + 1)} tone={oi === 0 ? "primary" : undefined} onClick={() => onAnswer({ kind: "answer", answers: { [q.question]: o.label } })}>
                {o.label}
              </Key>
            ))}
          </div>
          {q.options.some((o) => o.description) && <span className="mr-dim">{q.options.map((o) => `${o.label}: ${o.description}`).join(" · ")}</span>}
        </div>
      ))}
      <WayOut source={questions[0]?.question ?? ""} onOut={(x) => onAnswer(wayOut(questions, x))} />
    </div>
  );
}

/** The row under a question's options (I75): answer in your own words, have Claude ask first, or skip. */
export function WayOut({ source, onOut }: { source: string; onOut: (x: { kind: "reply"; text: string } | { kind: "ask_first" } | { kind: "skip" }) => void }) {
  const [text, setText] = useState("");
  return (
    <form className="mr-row" data-mr="WayOut" data-mr-source={source} style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) onOut({ kind: "reply", text: text.trim() }); }}>
      <input className="mr-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="None fit? Answer in your own words…" aria-label="Answer in your own words" style={{ flex: "1 1 240px", background: "var(--mr-well)" }} />
      {text.trim() && <Key submit>Send</Key>}
      <Key onClick={() => onOut({ kind: "ask_first" })}>Ask me first</Key>
      <Key k="S" onClick={() => onOut({ kind: "skip" })}>Skip</Key>
    </form>
  );
}
