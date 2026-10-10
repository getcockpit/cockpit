import { useEffect, useState } from "react";
import { ago, nowLine } from "../picker/now";
import type { SessionState, Todo } from "../state/types";
import { ProgressTrack, type Seg } from ".";

// A clock that ticks once a second while `on`: elapsed and quiet timers must move on their own.
export function useTick(on: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setT(Date.now());
    const i = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(i);
  }, [on]);
  return t;
}

// Live progress (MR-59, as a catalog Progress track since MR-60): one segment per plan step with
// the current one pulsing, the step Claude is on, and its timer. After a minute with nothing from
// Claude the segment turns amber and says so, so a stuck session never looks like a busy one.
export function LiveTrack({ s, compact }: { s: SessionState; compact?: boolean }) {
  const t = useTick(s.status === "working" || s.status === "starting");
  const n = nowLine(s, t);
  if (!n) return null;
  const segs = s.todos.length ? planSegs(s.todos, true) : ["current" as Seg];
  const step = segs.indexOf("current") + 1;
  const pct = s.todos.length ? Math.round((segs.filter((x) => x === "done").length / segs.length) * 100) : null;
  const left = [pct !== null ? `${pct}%` : "", s.todos.length > 1 && !compact ? `step ${step} of ${segs.length}` : "", n.label].filter(Boolean).join(" · ");
  const right = `${ago(n.elapsedMs)}${n.stale ? ` ${quiet(n.elapsedMs, n.quietMs, compact)}` : ""}`;
  return <ProgressTrack segs={segs} left={left} right={right} live stale={n.stale} source={s.id} fill />;
}

// One segment per plan step. While working, some step is always current (the next one to do).
export function planSegs(todos: Todo[], working = false): Seg[] {
  const segs: Seg[] = todos.map((x) => (x.status === "completed" ? "done" : x.status === "in_progress" ? "current" : "todo"));
  if (working && !segs.includes("current")) { const i = segs.indexOf("todo"); segs[i >= 0 ? i : segs.length - 1] = "current"; }
  return segs;
}

// The silence only needs its own timer when it started after the step did.
function quiet(elapsed: number, quietMs: number, compact?: boolean): string {
  const same = Math.abs(elapsed - quietMs) < 2000;
  if (compact) return same ? "· no word since" : `· quiet ${ago(quietMs)}`;
  return `${same ? "· no word from Claude since" : `· no word from Claude for ${ago(quietMs)}`} · ⌘. interrupts`;
}
