import type { ReactNode } from "react";
import type { DecisionSpec, Risk, TileSpec } from "../picker/pick";

// The component catalog (decision 16). Screens are composed only from these.

export function Lamps({ children }: { children: ReactNode }) {
  const n = Array.isArray(children) ? children.length : 1;
  return <section aria-label="Status lamps" className="mr-lamps" style={{ ["--n" as string]: n }}>{children}</section>;
}

export function Lamp({ value, label, on }: { value: string | number; label: string; on?: "needs" | "error" | "plain" | false }) {
  return (
    <div className="mr-lamp" data-mr="Lamp" data-mr-source={label} data-on={on || undefined}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
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
