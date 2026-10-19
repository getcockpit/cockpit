import { useEffect, useState } from "react";
import { api } from "../state/store";
import { DAY_NAMES, cronLabel, parseCron, toCron, type CronField, type CronRows } from "./cron";

// The cadence builder for recurring sessions (MR-169): presets, then one row per cron field
// (minutes, hours, weekdays, days of month) and the expression itself, kept in sync both ways.
// The core previews the next runs, so this side never schedules anything itself.

export const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "Every 5 min · work hours", expr: "*/5 9-17 * * 1-5" },
  { label: "Every 10 min", expr: "*/10 * * * *" },
  { label: "Hourly", expr: "0 * * * *" },
  { label: "Daily 09:00", expr: "0 9 * * *" },
  { label: "Weekdays 09:00", expr: "0 9 * * 1-5" },
  { label: "Mondays 09:00", expr: "0 9 * * 1" },
];

const seg = (on: boolean) => ({ border: 0, padding: "4px 10px", font: "inherit", cursor: "pointer", background: on ? "var(--mr-ink)" : "transparent", color: on ? "var(--mr-tile)" : "var(--mr-ink)" });
const chip = (on: boolean) => ({ border: 0, minWidth: 30, padding: "4px 6px", font: "inherit", fontSize: 12, cursor: "pointer", background: on ? "var(--mr-selected)" : "var(--mr-well)", color: on ? "var(--mr-tile)" : "var(--mr-ink)" });

function Row({ name, field, options, labelOf, step, onChange }: { name: string; field: CronField; options: number[]; labelOf: (n: number) => string; step?: number; onChange: (f: CronField) => void }) {
  const chosen = field.mode === "these" ? field.values : [];
  // Values the chips don't offer (minute 7) still show, so nothing is hidden.
  const shown = [...new Set([...options, ...chosen])].sort((a, b) => (options.indexOf(a) + 1 || 999) - (options.indexOf(b) + 1 || 999) || a - b);
  const toggle = (n: number) => onChange({ mode: "these", values: chosen.includes(n) ? chosen.filter((x) => x !== n) : [...chosen, n].sort((a, b) => a - b) });
  return (
    <div className="mr-row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "wrap" }} data-mr="CronRow" data-mr-source={name}>
      <span className="mr-dim" style={{ width: 96, paddingTop: 4 }}>{name}</span>
      <div role="radiogroup" aria-label={name} className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 2 }}>
        <button type="button" role="radio" aria-checked={field.mode === "every"} onClick={() => onChange({ mode: "every" })} style={seg(field.mode === "every")}>Any</button>
        {step && <button type="button" role="radio" aria-checked={field.mode === "step"} onClick={() => onChange({ mode: "step", n: field.mode === "step" ? field.n : step })} style={seg(field.mode === "step")}>Every N</button>}
        <button type="button" role="radio" aria-checked={field.mode === "these"} onClick={() => onChange({ mode: "these", values: chosen.length ? chosen : [options[0]] })} style={seg(field.mode === "these")}>These</button>
      </div>
      {field.mode === "step" && <label className="mr-row" style={{ gap: 6 }}>every
        <input type="number" min={1} max={options.length} aria-label={`${name}: every N`} value={field.n} onChange={(e) => onChange({ mode: "step", n: Math.max(1, Number(e.target.value) || 1) })} className="mr-input" style={{ width: 64, minHeight: 30, background: "var(--mr-well)" }} /></label>}
      {field.mode === "these" && <div className="mr-row" role="group" aria-label={`${name} values`} style={{ gap: 2, flexWrap: "wrap", flex: 1, minWidth: 240 }}>
        {shown.map((n) => <button key={n} type="button" aria-pressed={chosen.includes(n)} onClick={() => toggle(n)} style={chip(chosen.includes(n))}>{labelOf(n)}</button>)}
      </div>}
    </div>
  );
}

const range = (a: number, b: number, s = 1) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);
const pad = (n: number) => String(n).padStart(2, "0");
const when = (t: number) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

export function CronBuilder({ value, onChange, source }: { value: string; onChange: (expr: string) => void; source: string }) {
  const [text, setText] = useState(value);
  const [days, setDays] = useState(() => parseCron(value)?.dom.mode !== "every");
  const [preview, setPreview] = useState<{ next: number[]; error: string | null }>({ next: [], error: null });
  const rows = parseCron(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    let alive = true;
    api.schedulePreview({ kind: "cron", expr: value }).then((next) => alive && setPreview({ next, error: null })).catch((e) => alive && setPreview({ next: [], error: String(e).split("\n")[0] }));
    return () => { alive = false; };
  }, [value]);
  const set = (part: Partial<CronRows>) => rows && onChange(toCron({ ...rows, ...part }));
  const typed = (t: string) => { setText(t); if (parseCron(t)) onChange(t.trim().split(/\s+/).join(" ")); };
  const valid = !!parseCron(text);
  return (
    <div data-mr="CronBuilder" data-mr-source={source} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="mr-row" style={{ gap: 4, flexWrap: "wrap" }} role="group" aria-label="Presets">
        {CRON_PRESETS.map((p) => <button key={p.expr} type="button" aria-pressed={value === p.expr} onClick={() => onChange(p.expr)} style={chip(value === p.expr)} data-mr="CronPreset" data-mr-source={p.expr}>{p.label}</button>)}
      </div>
      {rows && <>
        <Row name="Minutes" field={rows.minute} options={range(0, 55, 5)} labelOf={(n) => `:${pad(n)}`} step={5} onChange={(minute) => set({ minute })} />
        <Row name="Hours" field={rows.hour} options={range(0, 23)} labelOf={pad} step={2} onChange={(hour) => set({ hour })} />
        <Row name="Weekdays" field={rows.dow} options={[1, 2, 3, 4, 5, 6, 0]} labelOf={(n) => DAY_NAMES[n]} onChange={(dow) => set({ dow })} />
        {days
          ? <Row name="Days of month" field={rows.dom} options={range(1, 31)} labelOf={String} step={2} onChange={(dom) => set({ dom })} />
          : <button type="button" className="mr-dim" onClick={() => setDays(true)} style={{ border: 0, background: "transparent", font: "inherit", cursor: "pointer", textAlign: "left", padding: "0 0 0 104px" }}>Days of month: any ▸</button>}
      </>}
      <div className="mr-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="mr-dim" style={{ width: 96 }}>Expression</span>
        <input aria-label="Cron expression" className="mr-input mr-mono" value={text} onChange={(e) => typed(e.target.value)} spellCheck={false}
          style={{ maxWidth: 220, minHeight: 30, background: "var(--mr-well)", boxShadow: valid ? undefined : "inset 0 -2px 0 var(--mr-error)" }} />
        <span className="mr-dim" style={{ fontSize: 12 }}>minute hour day month weekday · your local time</span>
      </div>
      <div data-mr="CronPreview" data-mr-source={source} style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 104 }}>
        {!valid ? <span role="alert" style={{ color: "var(--mr-error)" }}>Not a cron expression: 5 fields, like */10 9-17 * * 1-5</span>
          : preview.error ? <span role="alert" style={{ color: "var(--mr-error)" }}>{preview.error}</span>
          : <><strong>{cronLabel(value)}</strong><span className="mr-dim" style={{ fontSize: 12 }}>Next: {preview.next.map(when).join(" · ") || "—"}</span></>}
      </div>
    </div>
  );
}
