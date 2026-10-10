import { useEffect, useState } from "react";
import { ago, nowLine } from "../picker/now";
import type { Delivery, SessionState } from "../state/types";

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

// The live "now" line (MR-59): a pulsing dot, the current step and its timer. After a minute with
// nothing from Claude it turns amber and says so, so a stuck session never looks like a busy one.
export function NowLine({ s, compact }: { s: SessionState; compact?: boolean }) {
  const t = useTick(s.status === "working" || s.status === "starting");
  const n = nowLine(s, t);
  if (!n) return null;
  return (
    <span className="mr-now" data-mr="NowLine" data-mr-source={s.id} data-stale={n.stale || undefined} role="status" aria-live="polite">
      <i className="mr-now-dot" aria-hidden="true" />
      <span className="mr-ellipsis">{n.label}</span>
      <span className="mr-mono" style={{ flex: "none" }}>{ago(n.elapsedMs)}</span>
      {n.stale && <span className="mr-mono mr-ellipsis">{quiet(n.elapsedMs, n.quietMs, compact)}</span>}
    </span>
  );
}

// The silence only needs its own timer when it started after the step did.
function quiet(elapsed: number, quietMs: number, compact?: boolean): string {
  const same = Math.abs(elapsed - quietMs) < 2000;
  if (compact) return same ? "· no word since" : `· quiet ${ago(quietMs)}`;
  return `${same ? "· no word from Claude since" : `· no word from Claude for ${ago(quietMs)}`} · ⌘. interrupts`;
}

const SAY: Record<Delivery, [string, string]> = {
  sending: ["Sending…", "Handing it to Claude"],
  queued: ["Queued · after this step", "Claude is mid-step: it reads this at its next step"],
  taken: ["Claude has it", "Claude is working on this"],
  answered: ["Answered", "Its turn finished"],
  lost: ["Not delivered", "The session stopped before Claude read this: send it again"],
};

// Where a sent message is: Queued → Claude has it → Answered.
export function DeliveryMark({ d, id }: { d: Delivery; id: string }) {
  return <span className="mr-delivery mr-mono" data-mr="DeliveryMark" data-mr-source={id} data-d={d} title={SAY[d][1]}>{SAY[d][0]}</span>;
}
