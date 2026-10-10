// Backtest for Timeline forecasts (decision 29, MR-32): replay a real event log and, at every plan
// update of a working session, compare the forecast stop with when the session really stopped
// (needs you, turn finished, ended). Clock times ship only if 2 of 3 land within ±3 minutes.
//
//   bun scripts/backtest-timeline.ts <copy of events.sqlite>
//
// Run it on a copy: the app holds the live log open.
import { Database } from "bun:sqlite";
import { reduce, initialState } from "../ui/src/state/reduce";
import { forecast } from "../ui/src/picker/forecast";
import type { AppState, MrEvent } from "../ui/src/state/types";

const path = process.argv[2];
if (!path) { console.error("usage: bun scripts/backtest-timeline.ts <events.sqlite copy>"); process.exit(2); }
const db = new Database(path, { readonly: true });
const rows = db.query("SELECT id, session_id, kind, payload, anchor, created_at FROM events ORDER BY id").all() as { id: string; session_id: string | null; kind: string; payload: string; anchor: string | null; created_at: number }[];
const events: MrEvent[] = rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

type Guess = { session: string; at: number; predicted: number };
const open: Guess[] = [];
const done: (Guess & { actual: number })[] = [];
let state: AppState = initialState;
for (const ev of events) {
  const before = ev.session_id ? state.sessions[ev.session_id]?.status : undefined;
  state = reduce(state, ev);
  const s = ev.session_id ? state.sessions[ev.session_id] : undefined;
  if (!s) continue;
  // The session stopped: settle every open guess about it.
  if (before === "working" && s.status !== "working") {
    for (let i = open.length - 1; i >= 0; i--) if (open[i].session === s.id) done.push({ ...open.splice(i, 1)[0], actual: ev.created_at });
  }
  if (ev.kind === "plan.updated" && s.status === "working") {
    const f = forecast(s, Object.values(state.sessions), ev.created_at);
    if (f.kind === "eta") open.push({ session: s.id, at: ev.created_at, predicted: f.at });
  }
}

const errs = done.map((g) => (g.predicted - g.actual) / 60_000);
const within = errs.filter((e) => Math.abs(e) <= 3).length;
const fmt = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
console.log(`guesses settled: ${done.length} (unsettled ${open.length}) across ${new Set(done.map((g) => g.session)).size} sessions`);
if (done.length) {
  const sorted = [...errs].sort((a, b) => a - b);
  console.log(`within ±3 min: ${within}/${done.length} (${Math.round((within / done.length) * 100)}%)`);
  console.log(`error min (predicted − actual): median ${fmt(sorted[sorted.length >> 1])}, min ${fmt(sorted[0])}, max ${fmt(sorted.at(-1)!)}`);
}
console.log(`verdict: ${done.length >= 10 && within * 3 >= done.length * 2 ? "CLOCK TIMES" : done.length < 10 ? "TOO FEW SAMPLES: order only" : "ORDER ONLY"}`);
