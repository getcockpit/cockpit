import type { Diagram } from "../state/types";

// Picker layer 3's output, drawn by us (no Mermaid): nodes ranked left→right by longest path from
// a start node, stacked top→bottom within a rank. Small and boxy, in the Control Room palette.

const W = 168, H = 44, GX = 44, GY = 14, PAD = 8;
const FILL: Record<string, string> = { step: "var(--mr-well)", decision: "var(--mr-needs)", done: "var(--mr-well)", risk: "var(--mr-well)" };
const EDGE: Record<string, string> = { step: "var(--mr-ink-3)", decision: "var(--mr-needs-ink)", done: "var(--mr-done)", risk: "var(--mr-error)" };

export function layout(d: Diagram): Map<string, { x: number; y: number }> {
  // Drop back edges (found by DFS) so a cycle can't push nodes rightward, then rank by longest path.
  const out = new Map<string, string[]>(d.nodes.map((n) => [n.id, []]));
  for (const e of d.edges) out.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const forward: [string, string][] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) continue; // back edge
      forward.push([id, to]);
      if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
    order.unshift(id);
  };
  for (const n of d.nodes) if (!state.has(n.id)) visit(n.id);
  const rank = new Map(d.nodes.map((n) => [n.id, 0]));
  for (const id of order) for (const [f, t] of forward) if (f === id) rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(f) ?? 0) + 1));
  const rows = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of d.nodes) {
    const r = rank.get(n.id) ?? 0;
    const i = rows.get(r) ?? 0;
    rows.set(r, i + 1);
    pos.set(n.id, { x: PAD + r * (W + GX), y: PAD + i * (H + GY) });
  }
  return pos;
}

export function FlowDiagram({ d }: { d: Diagram }) {
  const pos = layout(d);
  const xs = [...pos.values()];
  const w = Math.max(...xs.map((p) => p.x)) + W + PAD, h = Math.max(...xs.map((p) => p.y)) + H + PAD;
  const kind = new Map(d.nodes.map((n) => [n.id, n.kind]));
  return (
    <figure data-mr="FlowDiagram" style={{ margin: 0, padding: "10px 14px", background: "var(--mr-tile)", overflowX: "auto" }}>
      {d.title && <figcaption className="mr-h" style={{ marginBottom: 6 }}>{d.title}</figcaption>}
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={d.title ?? "Flow diagram"} style={{ display: "block" }}>
        <defs><marker id="mr-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--mr-ink-3)" /></marker></defs>
        {d.edges.map((e, i) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const back = b.x <= a.x;
          const [x1, y1] = back ? [a.x + W / 2, a.y + H] : [a.x + W, a.y + H / 2];
          const [x2, y2] = back ? [b.x + W / 2, b.y + H] : [b.x, b.y + H / 2];
          const mx = (x1 + x2) / 2;
          const path = back ? `M${x1},${y1} C${x1},${y1 + 24} ${x2},${y2 + 24} ${x2},${y2}` : `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
          return (
            <g key={i}>
              <path d={path} fill="none" stroke={EDGE[kind.get(e.to) ?? "step"]} strokeWidth="1.5" markerEnd="url(#mr-arrow)" />
              {e.label && <text x={mx} y={(y1 + y2) / 2 - 4} textAnchor="middle" fontSize="10" fill="var(--mr-ink-2)" fontFamily="var(--mr-mono)">{e.label}</text>}
            </g>
          );
        })}
        {d.nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id} data-mr="FlowNode" data-mr-source={n.id}>
              <rect x={p.x} y={p.y} width={W} height={H} fill={FILL[n.kind] ?? FILL.step} stroke={n.kind === "risk" ? "var(--mr-error)" : n.kind === "done" ? "var(--mr-done)" : "none"} strokeWidth="2" />
              <foreignObject x={p.x} y={p.y} width={W} height={H}>
                <div style={{ height: "100%", display: "flex", alignItems: "center", gap: 6, padding: "0 8px", fontSize: 12, lineHeight: 1.2, color: n.kind === "decision" ? "var(--mr-needs-ink)" : "var(--mr-ink)" }}>
                  <span className="mr-mono" style={{ fontSize: 10, opacity: 0.7 }}>{n.kind === "decision" ? "?" : n.kind === "done" ? "✓" : n.kind === "risk" ? "!" : "→"}</span>
                  <span>{n.label}</span>
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
