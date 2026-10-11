import type { SessionState, Todo } from "../state/types";
import { pickTile } from "./pick";

// Timeline forecasts (decision 29, MR-32): when each session will next want you, guessed from how
// long its plan steps have taken so far. Pure, so the backtest and the screen share one guess.

const MIN = 60_000;
/** Step length with nothing to go on: no finished steps anywhere in the log. */
export const DEFAULT_STEP_MS = 4 * MIN;

/** Clock times ("~14:06") or only the order ("next")? Decided by `scripts/backtest-timeline.ts`:
 *  on 2026-10-11 the real log gave 20 of 31 within ±3 min (65%, 5 sessions), under the 2-of-3 bar,
 *  so the Timeline shows order only (I48). Re-run it as plans pile up; flip this when it passes. */
export const CLOCK_TIMES = false;

export type Ending = "needs" | "review" | "done";
export type Forecast =
  | { kind: "paused"; label: string } // waiting on you right now
  | { kind: "eta"; at: number; ending: Ending; label: string } // predicted stop
  | { kind: "none"; label: string }; // no plan or not running: no guess

/** How long finished steps took, in ms (zero-length ones, logged done on arrival, don't count). */
export function stepDurations(todos: Todo[]): number[] {
  return todos.filter((t) => t.status === "completed" && t.since != null && t.doneAt != null && t.doneAt > t.since).map((t) => t.doneAt! - t.since!);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** This session's typical step, else the whole log's, else four minutes. */
export function typicalStep(s: SessionState, all: SessionState[]): number {
  return median(stepDurations(s.todos)) ?? median(all.flatMap((x) => stepDurations(x.todos))) ?? DEFAULT_STEP_MS;
}

/** What waits at the end of the plan: a plan session hands you a spec, review flows a review. */
export function endingFor(s: SessionState): Ending {
  return s.kind === "plan" ? "needs" : s.kind === "review" || s.kind === "address" ? "review" : "done";
}

const ENDING: Record<Ending, string> = { needs: "Spec ready for you", review: "Ready to review", done: "Done" };

export function forecast(s: SessionState, all: SessionState[], now: number, median = typicalStep(s, all)): Forecast {
  // Waiting on you in any form the wall counts: a card, a question in prose, a flow step.
  if (s.status === "needs_you" || pickTile(s).state === "needs_you") return { kind: "paused", label: "Waiting on you" };
  if (s.status === "ended") return { kind: "none", label: "Done" };
  if (s.status === "error") return { kind: "none", label: "Stopped with an error" };
  if (s.status === "interrupted") return { kind: "none", label: "Interrupted" };
  if (s.status === "idle") return { kind: "none", label: s.backgroundTasks.length ? "Running in background" : "Turn finished" };
  const left = s.todos.filter((t) => t.status !== "completed");
  if (!s.todos.length || !left.length) return { kind: "none", label: s.todos.length ? "Wrapping up" : "No plan" };
  // The current step gets what's left of a typical step, but never less than a quarter of one:
  // a step running long is likely to run on a bit longer, not to end this second.
  const cur = left.find((t) => t.status === "in_progress");
  const curLeft = cur?.since != null ? Math.max(median - (now - cur.since), median / 4) : median;
  const rest = left.length - (cur ? 1 : 0);
  const ending = endingFor(s);
  return { kind: "eta", at: now + curLeft + rest * median, ending, label: ENDING[ending] };
}

/** "~14:06" or, before the backtest clears clock times, nothing (the order says it). */
export function clock(at: number): string {
  return `~${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** "in ~2 min" for the header sentence. */
export function inMinutes(at: number, now: number): string {
  const m = Math.max(1, Math.round((at - now) / MIN));
  return `in ~${m} min`;
}

export type Upcoming = { title: string; f: Extract<Forecast, { kind: "eta" }> };

/** Soonest first. */
export function soonest(xs: Upcoming[]): Upcoming[] {
  return [...xs].sort((a, b) => a.f.at - b.f.at);
}

/** The Timeline's one-sentence answer to "when am I needed next?" (MR-32). With clock times it
 *  says when; without (CLOCK_TIMES false) it says who, in order, and never a minute count. */
export function headline(needsNow: number, upcoming: Upcoming[], now: number, clockTimes = CLOCK_TIMES, horizon = 15 * MIN): string {
  const up = soonest(upcoming);
  const needs = up.filter((u) => u.f.ending === "needs"), finish = up.filter((u) => u.f.ending !== "needs");
  const out: string[] = [];
  const first = needs[0], second = needs[1];
  if (clockTimes) {
    const soon = first && first.f.at - now <= horizon ? first : null;
    out.push(needsNow
      ? `You're needed now${soon ? `, then again ${inMinutes(soon.f.at, now)}` : ""}.`
      : soon ? `You'll be needed ${inMinutes(soon.f.at, now)}, by ${soon.title}.` : "Nothing needs you now.");
    const after = soon ? second : first;
    out.push(after ? `After that it's quiet until about ${clock(after.f.at).slice(1)}.` : `After that, nothing is expected to need you.`);
    const by = after?.f.at ?? now + horizon;
    const n = finish.filter((u) => u.f.at <= by).length;
    if (n) out.push(`${finishes(n)} before then.`);
  } else {
    out.push(needsNow
      ? `You're needed now${first ? `; ${first.title} is next` : ""}.`
      : first ? `Nothing needs you now; ${first.title} is next.` : "Nothing needs you now.");
    if (!first) out.push("Nothing running is expected to need you.");
    if (finish.length) out.push(`${finishes(finish.length)}.`);
  }
  return out.join(" ");
}

const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];
const finishes = (n: number) => (n === 1 ? "One session finishes on its own" : `${WORDS[n] ?? n} sessions finish on their own`);

/** "Next", "2nd", "3rd"… for order-only forecasts (the session cap keeps this short). */
export function ordinal(i: number): string {
  return ["Next", "2nd", "3rd"][i] ?? `${i + 1}th`;
}
