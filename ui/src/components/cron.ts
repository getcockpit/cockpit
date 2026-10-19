import type { Cadence } from "../state/types";

// Cron cadences for recurring sessions (MR-169): the builder's rows ↔ a 5-field expression, and the
// plain-English label. The core parses and schedules the same expressions (schedules.rs); this side
// only edits and describes them. Weekdays are 0 = Sunday … 6 = Saturday, as in cron.

/** One builder row: every value, every Nth from the first, or these values. */
export type CronField = { mode: "every" } | { mode: "step"; n: number } | { mode: "these"; values: number[] };
export type CronRows = { minute: CronField; hour: CronField; dom: CronField; month: string; dow: CronField };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/** A field's values, or null when it isn't valid. */
function values(s: string, lo: number, hi: number, names: string[] = []): number[] | null {
  const num = (t: string) => {
    const i = names.indexOf(t.toLowerCase());
    const n = i >= 0 ? i + (names.length === 12 ? 1 : 0) : /^\d+$/.test(t) ? Number(t) : NaN;
    return n >= lo && n <= hi ? n : null;
  };
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : /^\d+$/.test(stepS) ? Number(stepS) : 0;
    if (step < 1) return null;
    let a: number | null, b: number | null;
    if (range === "*") [a, b] = [lo, hi];
    else if (range.includes("-")) { const [x, y] = range.split("-"); [a, b] = [num(x), num(y)]; }
    else { a = num(range); b = stepS === undefined ? a : hi; }
    if (a === null || b === null || a > b) return null;
    for (let n = a; n <= b; n += step) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

function toField(s: string, lo: number, hi: number, names?: string[]): CronField | null {
  if (s === "*") return { mode: "every" };
  const m = /^\*\/(\d+)$/.exec(s);
  if (m && Number(m[1]) > 0) return { mode: "step", n: Number(m[1]) };
  const v = values(s, lo, hi, names);
  return v ? { mode: "these", values: v } : null;
}

/** The builder rows of an expression, or null when it isn't one. */
export function parseCron(expr: string): CronRows | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [minute, hour, dom, dowRaw] = [toField(f[0], 0, 59), toField(f[1], 0, 23), toField(f[2], 1, 31), toField(f[4], 0, 7, WEEKDAYS)];
  if (!minute || !hour || !dom || !dowRaw || !values(f[3], 1, 12, MONTHS)) return null;
  // 7 is Sunday too.
  const dow: CronField = dowRaw.mode === "these" ? { mode: "these", values: [...new Set(dowRaw.values.map((d) => d % 7))].sort((a, b) => a - b) } : dowRaw;
  return { minute, hour, dom, month: f[3], dow };
}

/** `1,2,3,5` → `1-3,5`. */
function ranges(v: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    out.push(j - i >= 2 ? `${v[i]}-${v[j]}` : v.slice(i, j + 1).join(","));
    i = j;
  }
  return out.join(",");
}

function fieldExpr(f: CronField): string {
  return f.mode === "every" ? "*" : f.mode === "step" ? `*/${f.n}` : f.values.length ? ranges(f.values) : "*";
}

export function toCron(r: CronRows): string {
  return [fieldExpr(r.minute), fieldExpr(r.hour), fieldExpr(r.dom), r.month || "*", fieldExpr(r.dow)].join(" ");
}

/** The cron expression of any cadence: the older kinds as the core converts them. */
export function cadenceExpr(c: Cadence): string {
  if (c.kind === "cron") return c.expr;
  const [h, m] = (c.at ?? "09:00").split(":").map(Number);
  switch (c.kind) {
    case "daily": return `${m} ${h} * * *`;
    case "weekdays": return `${m} ${h} * * 1-5`;
    case "weekly": return `${m} ${h} * * ${[...(c.days ?? [1])].sort((a, b) => a - b).join(",")}`;
    case "hourly": { const e = c.every_h ?? 1; return `${m} ${h % e}-23/${e} * * *`; }
  }
}

/** Mon–Fri, Mon, Thu: in Monday-first order, runs of three or more as a range. */
function dayList(v: number[]): string {
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => v.includes(d));
  const out: string[] = [];
  for (let i = 0; i < order.length; i++) {
    let j = i;
    while (j + 1 < order.length && (order[j + 1] === order[j] + 1 || (order[j] === 6 && order[j + 1] === 0))) j++;
    out.push(j - i >= 2 ? `${DAY_NAMES[order[i]]}–${DAY_NAMES[order[j]]}` : order.slice(i, j + 1).map((d) => DAY_NAMES[d]).join(", "));
    i = j;
  }
  return out.join(", ");
}

const hourList = (v: number[]) => ranges(v).split(",").map((r) => r.includes("-") ? r.split("-").map((h) => pad(Number(h))).join("–") : pad(Number(r))).join(", ");

/** "Every 5 min, 09–17h, Mon–Fri", "Weekdays at 09:00", "Mon, Thu at 10:00". */
export function cronLabel(expr: string): string {
  const r = parseCron(expr);
  if (!r) return expr;
  const { minute: mi, hour: h, dom, dow } = r;
  const one = (f: CronField) => f.mode === "these" && f.values.length === 1 ? f.values[0] : null;
  // 0-23/3 lists every third hour: say so rather than eight hours.
  const hv = h.mode === "these" ? h.values : [];
  const hStep = hv.length >= 3 && hv.every((x, i) => i === 0 || x - hv[i - 1] === hv[1] - hv[0]) && hv[0] < hv[1] - hv[0] && hv[hv.length - 1] + hv[1] - hv[0] > 23 ? hv[1] - hv[0] : 0;
  let at: string | null = null, time: string;
  if (one(mi) !== null && h.mode === "these" && h.values.length <= 3 && !hStep) at = h.values.map((x) => `${pad(x)}:${pad(one(mi)!)}`).join(", ");
  if (mi.mode === "every") time = "Every minute";
  else if (mi.mode === "step") time = `Every ${mi.n} min`;
  else if (one(mi) !== null && hStep) time = `Every ${hStep} h from ${pad(hv[0])}:${pad(one(mi)!)}`;
  else if (one(mi) !== null) time = h.mode === "step" ? `Every ${h.n} h at :${pad(one(mi)!)}` : `Hourly at :${pad(one(mi)!)}`;
  else time = `At minutes ${ranges(mi.values)}`;
  const hours = at || hStep || h.mode !== "these" ? "" : `${hourList(h.values)}h`;
  if (mi.mode !== "these" && h.mode === "step") time += `, every ${h.n} h`;
  const days = [
    dow.mode === "these" && dom.mode === "every" && dow.values.join() === "1,2,3,4,5" ? "Weekdays" : "",
    dow.mode === "these" && !(dom.mode === "every" && dow.values.join() === "1,2,3,4,5") ? dayList(dow.values) : "",
    dom.mode !== "every" ? `day ${dom.mode === "step" ? `every ${dom.n}` : ranges(dom.values)}` : "",
    r.month !== "*" ? `in ${r.month}` : "",
  ].filter(Boolean);
  const day = days.join(dom.mode !== "every" && dow.mode !== "every" ? " or " : ", ");
  if (at) return day ? `${day} at ${at}` : `Daily at ${at}`;
  return [time, hours, day].filter(Boolean).join(", ");
}

/** The next `count` times (ms) an expression runs after `from`: for the demo, the core does it for real. */
export function nextRuns(expr: string, from: number, count = 5): number[] {
  const r = parseCron(expr);
  if (!r) return [];
  const all = (f: CronField, lo: number, hi: number) => f.mode === "every" ? null : f.mode === "step" ? Array.from({ length: hi - lo + 1 }, (_, i) => i + lo).filter((x) => (x - lo) % f.n === 0) : f.values;
  const [mi, h, dom, dow] = [all(r.minute, 0, 59), all(r.hour, 0, 23), all(r.dom, 1, 31), all(r.dow, 0, 6)];
  const months = values(r.month, 1, 12, MONTHS) ?? [];
  const out: number[] = [];
  const t = new Date(from);
  t.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 40 && out.length < count; i++) {
    t.setMinutes(t.getMinutes() + 1);
    const domOk = !dom || dom.includes(t.getDate()), dowOk = !dow || dow.includes(t.getDay());
    const dayOk = dom && dow ? domOk || dowOk : domOk && dowOk;
    if (dayOk && months.includes(t.getMonth() + 1) && (!h || h.includes(t.getHours())) && (!mi || mi.includes(t.getMinutes()))) out.push(t.getTime());
  }
  return out;
}
