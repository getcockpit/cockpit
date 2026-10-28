import { useState, type ReactNode } from "react";
import type { DecisionSpec, Risk, TileSpec } from "../picker/pick";
import type { Delivery } from "../state/types";
import { keyLabel } from "../platform";
import { basename } from "../fspath";

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

export function Key({ k, children, tone, onClick, disabled, submit, pressed }: { k?: string; children: ReactNode; tone?: "primary" | "needs"; onClick?: () => void; disabled?: boolean; submit?: boolean; pressed?: boolean }) {
  return (
    <button type={submit ? "submit" : "button"} className="mr-key" data-tone={tone} onClick={onClick} disabled={disabled} aria-pressed={pressed}>
      {k && <kbd>{keyLabel(k)}</kbd>}
      {children}
    </button>
  );
}

const GLYPH: Record<TileSpec["state"], string> = { needs_you: "◆", working: "○", almost: "◔", idle: "‖", review: "◇", done: "✓", error: "✕", starting: "…", interrupted: "■" };
export const LABEL: Record<TileSpec["state"], string> = { needs_you: "Needs you", working: "Working", almost: "Almost done", idle: "Waiting", review: "Ready to review", done: "Done", error: "Error", starting: "Starting", interrupted: "Interrupted" };

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
export const ASK_FIRST = "None of these options fit. Before offering options again, ask me 1-3 short clarifying questions in one AskUserQuestion call (all of them together, each with your best-guess options; I can answer in my own words), then ask again with better options.";
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
    : spec.component === "DiffCard" ? `${spec.tool === "Write" ? "Create" : "Edit"} ${basename(spec.path)}`
    : `Use ${spec.tool}`;
  const body = spec.component === "CommandCard" ? spec.command : spec.component === "DiffCard" ? spec.preview : spec.summary;
  return (
    <>
      <span className="mr-ask">{title}</span>
      {spec.component === "DiffCard" && <span className="mr-mono mr-dim">{spec.path} · +{spec.added} −{spec.removed}</span>}
      {body && <pre className="mr-code">{body}</pre>}
      <RiskMeter risk={spec.risk} why={spec.why} />
      {/* High risk: the safe answer leads, so a glance never lands on Allow (MR-139). */}
      <div className="mr-row" style={{ flexWrap: "wrap" }}>
        {spec.risk === "high" && <Key k="D" tone="primary" onClick={() => onAnswer({ kind: "deny" })}>Deny</Key>}
        <Key k="A" tone={spec.risk === "high" ? undefined : "needs"} onClick={() => onAnswer({ kind: "allow" })}>Allow</Key>
        <Key k="S" onClick={() => onAnswer({ kind: "allow", always: true })}>Allow for this session</Key>
        {spec.risk !== "high" && <Key k="D" onClick={() => onAnswer({ kind: "deny" })}>Deny</Key>}
      </div>
    </>
  );
}

/** One pick on a card with several questions: they're all sent together once each has an answer
 *  (sending on the first click dropped the rest). Picking again changes an answer. */
export function pickAnswer(questions: { question: string }[], picks: Record<string, string>, question: string, label: string): { picks: Record<string, string>; done: boolean } {
  const next = { ...picks, [question]: label };
  return { picks: next, done: questions.every((q) => q.question in next) };
}

/** A click on a multi-select option: it toggles, and the picks keep the options' order. The answer
 *  Claude gets is the labels joined with ", ", like Claude Code's own multi-select. */
export function toggleOption(options: { label: string }[], chosen: string[], label: string): string[] {
  const next = chosen.includes(label) ? chosen.filter((x) => x !== label) : [...chosen, label];
  return options.map((o) => o.label).filter((l) => next.includes(l));
}

// A question with its options, plus a way out when none fit: answer in your own words, have Claude
// ask you first, or skip it. With several questions, each gets its answer and the card sends them together.
function QuestionCard({ questions, onAnswer }: { questions: Extract<DecisionSpec, { component: "QuestionCard" }>["questions"]; onAnswer: (a: Answer) => void }) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const many = questions.length > 1;
  // A multi-select question has no "done" click, so the card waits for Send instead of sending itself.
  const multi = questions.some((q) => q.multiSelect);
  const pick = (question: string, label: string) => {
    if (!many && !multi) return onAnswer({ kind: "answer", answers: { [question]: label } });
    const r = pickAnswer(questions, picks, question, label);
    setPicks(r.picks);
    if (r.done && !multi) onAnswer({ kind: "answer", answers: r.picks });
  };
  const toggle = (q: (typeof questions)[number], label: string) => {
    const next = toggleOption(q.options, chosen[q.question] ?? [], label);
    setChosen({ ...chosen, [q.question]: next });
    const { [q.question]: _, ...rest } = picks;
    setPicks(next.length ? { ...rest, [q.question]: next.join(", ") } : rest);
  };
  const answered = Object.keys(picks).length;
  // Own words answer the first question still open.
  const open = questions.find((q) => !(q.question in picks));
  return (
    <div className="mr-queue" style={{ gap: 12 }}>
      {(many || multi) && <span className="mr-dim" data-mr="QuestionProgress" data-mr-source={questions[0].question}>{many ? `${answered} of ${questions.length} answered · ` : ""}{multi ? "pick any that apply, then Send" : "sent when all are"}</span>}
      {questions.map((q, qi) => (
        <div key={qi} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="mr-ask">{many ? `${qi + 1}. ` : ""}{q.question}{q.multiSelect ? <span className="mr-dim"> · pick any</span> : null}</span>
          <div className="mr-row" style={{ flexWrap: "wrap" }}>
            {q.options.map((o, oi) => {
              const on = q.multiSelect ? (chosen[q.question] ?? []).includes(o.label) : many || multi ? picks[q.question] === o.label : oi === 0;
              return (
                <Key key={oi} k={many || multi ? undefined : String(oi + 1)} tone={on ? "primary" : undefined} pressed={q.multiSelect ? on : undefined} onClick={() => (q.multiSelect ? toggle(q, o.label) : pick(q.question, o.label))}>
                  {q.multiSelect ? (on ? "☑ " : "☐ ") : ""}{o.label}
                </Key>
              );
            })}
            {(many || multi) && q.question in picks && !q.multiSelect && !q.options.some((o) => o.label === picks[q.question]) && <Key tone="primary">{picks[q.question]}</Key>}
          </div>
          {q.options.some((o) => o.description) && <span className="mr-dim">{q.options.map((o) => `${o.label}: ${o.description}`).join(" · ")}</span>}
        </div>
      ))}
      {multi && <div className="mr-row"><Key tone="needs" disabled={!!open} onClick={() => onAnswer({ kind: "answer", answers: picks })}>Send{open && many ? ` · ${questions.length - answered} left` : ""}</Key></div>}
      <WayOut source={questions[0]?.question ?? ""} placeholder={many && open ? `None fit for ${questions.indexOf(open) + 1}? Answer it in your own words…` : undefined} onOut={(x) => (x.kind === "reply" && many && open ? pick(open.question, x.text) : onAnswer(wayOut(questions, x)))} />
    </div>
  );
}

/** A plan-doc question that takes several answers (data.multiSelect, I94): options toggle, and Send
 *  records the picks as one decision, "A, B". Starts from the current decision so it can be changed. */
export function PickAny({ source, options, decision, onDecide }: { source: string; options: { label: string; description: string }[]; decision?: string | null; onDecide: (label: string) => void }) {
  const [chosen, setChosen] = useState<string[]>(() => options.map((o) => o.label).filter((l) => (decision ?? "").split(", ").includes(l)));
  const joined = chosen.join(", ");
  return (
    <div data-mr="PickAny" data-mr-source={source} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="mr-dim">Pick any that apply, then Send.</span>
      {options.map((o, i) => {
        const on = chosen.includes(o.label);
        return (
          <button key={o.label} type="button" data-option={i} aria-pressed={on} onClick={() => setChosen((c) => toggleOption(options, c, o.label))} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", border: 0, background: "var(--mr-well)", boxShadow: on ? "inset 3px 0 0 var(--mr-selected)" : undefined, font: "inherit", color: "var(--mr-ink)", textAlign: "left", cursor: "pointer" }}>
            <strong>{on ? "☑" : "☐"} {o.label}</strong>{o.description && <span className="mr-dim" style={{ fontSize: 12 }}>{o.description}</span>}
          </button>
        );
      })}
      <div className="mr-row" style={{ marginTop: 4 }}>
        <Key tone="needs" disabled={!chosen.length || joined === decision} onClick={() => onDecide(joined)}>{decision ? "Change decision" : "Send"}{chosen.length ? ` · ${chosen.length} picked` : ""}</Key>
      </div>
    </div>
  );
}

/** The row under a question's options (I75): answer in your own words, have Claude ask first, or skip. */
export function WayOut({ source, placeholder, onOut }: { source: string; placeholder?: string; onOut: (x: { kind: "reply"; text: string } | { kind: "ask_first" } | { kind: "skip" }) => void }) {
  const [text, setText] = useState("");
  return (
    <form className="mr-row" data-mr="WayOut" data-mr-source={source} style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onOut({ kind: "reply", text: text.trim() }); setText(""); } }}>
      <input className="mr-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder ?? "None fit? Answer in your own words…"} aria-label="Answer in your own words" style={{ flex: "1 1 240px", background: "var(--mr-well)" }} />
      {text.trim() && <Key submit>Send</Key>}
      <Key onClick={() => onOut({ kind: "ask_first" })}>Ask me first</Key>
      <Key k="S" onClick={() => onOut({ kind: "skip" })}>Skip</Key>
    </form>
  );
}
