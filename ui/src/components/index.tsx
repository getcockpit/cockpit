import type { ReactNode } from "react";
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

export function Key({ k, children, tone, onClick, disabled }: { k?: string; children: ReactNode; tone?: "primary" | "needs"; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="mr-key" data-tone={tone} onClick={onClick} disabled={disabled}>
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
// `pct` leads the caption as a bold figure, so the share done reads at a glance.
export function ProgressTrack({ segs, left, right, live, stale, source, fill, pct }: { segs: Seg[]; left: ReactNode; right?: ReactNode; live?: boolean; stale?: boolean; source?: string; fill?: boolean; pct?: number | null }) {
  const n = Math.max(1, segs.length), done = segs.filter((s) => s === "done").length, cur = segs.includes("current") ? 1 : 0;
  return (
    <div className="mr-track" data-mr="ProgressTrack" data-mr-source={source} data-live={live || undefined} data-stale={stale || undefined} data-fill={fill || undefined} role="progressbar" aria-valuenow={Math.round((done / n) * 100)}>
      {fill
        ? <div className="mr-track-fill" aria-hidden="true"><i data-seg="done" style={{ width: `${(done / n) * 100}%` }} /><i data-seg="current" style={{ width: `${(cur / n) * 100}%` }} /></div>
        : <div className="mr-track-segs" aria-hidden="true">{segs.map((s, i) => <i key={i} data-seg={s} />)}</div>}
      <div className="mr-track-cap">{pct != null && <b className="mr-track-pct">{pct}%</b>}<span className="mr-ellipsis">{left}</span>{right && <span className="mr-track-right">{right}</span>}</div>
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

// One card for every decision; the body depends on the picked spec.
export function DecisionCard({ spec, onAnswer }: { spec: DecisionSpec; onAnswer: (a: Answer) => void }) {
  if (spec.component === "QuestionCard") {
    return (
      <div className="mr-queue" style={{ gap: 12 }}>
        {spec.questions.map((q, qi) => (
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
      </div>
    );
  }
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
