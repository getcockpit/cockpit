import { useState } from "react";
import { ago } from "../picker/now";
import type { SessionState } from "../state/types";
import { api } from "../state/store";
import { Key } from ".";

// The /goal Claude keeps working toward: its condition, how many checks it hasn't passed yet and
// why, and Cancel. A goal turn doesn't stop on its own until the condition is met, so Cancel
// interrupts it first; `/goal clear` is then taken as a command, not as a message mid-turn.
export function GoalStrip({ s, readOnly = false }: { s: SessionState; readOnly?: boolean }) {
  const [cancelling, setCancelling] = useState(false);
  const g = s.goal;
  if (!g) return null;
  const running = s.status === "working" || s.status === "starting";
  const cancel = async () => {
    setCancelling(true);
    try {
      if (running) await api.interrupt(s.id);
      await api.send(s.id, "/goal clear");
    } finally { setCancelling(false); }
  };
  return (
    <div className="mr-qrow" data-mr="GoalStrip" data-mr-source={s.id}>
      <div className="mr-flag" style={{ background: "var(--mr-selected)" }} />
      <div className="mr-qbody" style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <div className="mr-grow" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="mr-dim">Goal · set {ago(g.setAt)}{g.iterations ? ` · not met after ${g.iterations} ${g.iterations === 1 ? "check" : "checks"}` : ""}</span>
          <strong style={{ fontSize: 15, overflowWrap: "anywhere" }}>{g.condition}</strong>
          {g.lastReason && <span className="mr-ink2" style={{ fontSize: 13 }} title={g.lastReason}>Not yet: {g.lastReason.length > 220 ? `${g.lastReason.slice(0, 217)}…` : g.lastReason}</span>}
        </div>
        {!readOnly && <Key onClick={() => void cancel()} disabled={cancelling}>{cancelling ? "Cancelling…" : running ? "Stop & cancel goal" : "Cancel goal"}</Key>}
      </div>
    </div>
  );
}
