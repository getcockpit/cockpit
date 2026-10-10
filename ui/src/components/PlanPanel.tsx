import { ago } from "../picker/now";
import type { SessionState } from "../state/types";
import { ProgressTrack } from ".";
import { Mark } from "./Turn";
import { planSegs, useTick } from "./Now";

// The plan Claude is executing (plan_set, MR-62): how far along, what it's on and for how long,
// and what's left. Pinned beside the transcript so it stays in view while that scrolls.
export function PlanPanel({ s }: { s: SessionState }) {
  const working = s.status === "working" || s.status === "starting";
  const t = useTick(working);
  const todos = s.todos;
  const done = todos.filter((x) => x.status === "completed").length;
  const pct = Math.round((done / todos.length) * 100);
  const current = todos.find((x) => x.status === "in_progress");
  const left = todos.length - done;
  return (
    <section data-mr="PlanPanel" data-mr-source={s.id} style={{ background: "var(--mr-tile)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="mr-row" style={{ alignItems: "baseline" }}>
        <h2 className="mr-h mr-grow">Plan</h2>
        <span className="mr-mono" style={{ fontSize: 12 }}><b>{done}</b> of {todos.length} · <b>{pct}%</b></span>
      </div>
      <ProgressTrack segs={planSegs(todos, working)} live={working} source={s.id}
        left={current ? (current.activeForm || current.content) : left ? `${left} left` : "All steps done"}
        right={current?.since && working ? ago(Math.max(0, t - current.since)) : undefined} />
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {todos.map((x, i) => {
          const on = x.status === "in_progress";
          return (
            <li key={i} data-mr="PlanStep" data-mr-source={`${s.id}:${i}`} className="mr-row" style={{ alignItems: "baseline", gap: 8, padding: "4px 0", color: x.status === "completed" ? "var(--mr-ink-3)" : on ? "var(--mr-ink)" : "var(--mr-ink-2)", fontWeight: on ? 700 : 400 }}>
              <span style={{ flex: "none", width: 14, display: "inline-flex", justifyContent: "center" }}>
                {x.status === "completed" ? <Mark tone="done" /> : on ? <span aria-label="In progress">▸</span> : <Mark tone="todo" />}
              </span>
              <span className="mr-grow" style={{ textDecoration: x.status === "completed" ? "line-through" : undefined }}>{on && x.activeForm ? x.activeForm : x.content}</span>
              {on && x.since && working && <span className="mr-mono" style={{ fontSize: 11, fontWeight: 400 }}>{ago(Math.max(0, t - x.since))}</span>}
            </li>
          );
        })}
      </ol>
      {left > 0 && <span className="mr-dim" style={{ fontSize: 12 }}>{left === 1 ? "1 step left" : `${left} steps left`}{!working && current ? " · paused" : ""}</span>}
    </section>
  );
}
