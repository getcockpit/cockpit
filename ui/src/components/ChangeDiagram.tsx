import { changeLabel } from "./CatalogView";

// The review overview's change graph (Step 5 of /review) as a connected diagram, top-down like the
// skill's own ASCII DAG: sources on top, one row per rank. Width is scarce in the Focus pane and
// height isn't, so a fan-out spreads sideways across a row instead of bundling into one gap. Each
// box's arrows leave and enter at spread-out points along its edge, and a label sits just above
// the arrowhead it names.

export type ChangeNode = { id?: string; label: string; mark?: string; finding?: string | null };
export type ChangeEdge = { from: string; to: string; label?: string | null };
type Node = { id: string; label: string; mark: "+" | "~" | "-"; finding: string | null };

const W = 176, H = 40, GX = 24, GY = 64, PAD = 8;
const MARK = { "+": { word: "New", color: "var(--mr-done)" }, "~": { word: "Changed", color: "var(--mr-ink-2)" }, "-": { word: "Removed", color: "var(--mr-error)" } } as const;

/** Nodes with ids and edges resolved by id or label; null when there are no arrows to draw. */
export function changeGraph(nodes: ChangeNode[], edges: ChangeEdge[]): { nodes: Node[]; edges: { from: string; to: string; label: string | null }[] } | null {
  const ns: Node[] = nodes.map((n, i) => {
    const m = (n.mark || /^\s*([~+\-])\s/.exec(n.label)?.[1] || "~").replace("−", "-");
    return { id: n.id || `n${i + 1}`, label: changeLabel(n.label), mark: (m in MARK ? m : "~") as Node["mark"], finding: n.finding ?? null };
  });
  const ref = new Map<string, string>();
  nodes.forEach((n, i) => [ns[i].id, n.label, ns[i].label].forEach((k) => ref.set(k, ns[i].id)));
  const es = edges.map((e) => ({ from: ref.get(e.from) ?? "", to: ref.get(e.to) ?? "", label: e.label || null })).filter((e) => e.from && e.to && e.from !== e.to);
  return es.length ? { nodes: ns, edges: es } : null;
}

export function layoutChanges(g: NonNullable<ReturnType<typeof changeGraph>>) {
  // Drop back edges (DFS) so a cycle can't push nodes down forever, then rank by longest path.
  const out = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) out.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>(), order: string[] = [], forward: [string, string][] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) continue;
      forward.push([id, to]);
      if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
    order.unshift(id);
  };
  for (const n of g.nodes) if (!state.has(n.id)) visit(n.id);
  const rank = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const id of order) for (const [f, t] of forward) if (f === id) rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(f) ?? 0) + 1));
  // Rows in rank order; within a row, order by the parents' mean position so arrows cross less.
  const rows: string[][] = [];
  for (const n of g.nodes) (rows[rank.get(n.id) ?? 0] ??= []).push(n.id);
  const slot = new Map<string, number>();
  rows.forEach((row, r) => {
    if (r > 0) {
      const bary = (id: string) => {
        const ps = forward.filter(([, t]) => t === id).map(([f]) => slot.get(f)).filter((x): x is number => x !== undefined);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
      };
      row.sort((a, b) => bary(a) - bary(b));
    }
    row.forEach((id, i) => slot.set(id, i - (row.length - 1) / 2));
  });
  const widest = Math.max(...rows.map((r) => r?.length ?? 0));
  const width = PAD * 2 + 48 + widest * W + (widest - 1) * GX; // 24 a side for arrows routed round a row
  const pos = new Map<string, { x: number; y: number }>();
  rows.forEach((row, r) => row.forEach((id) => pos.set(id, { x: width / 2 - W / 2 + (slot.get(id) ?? 0) * (W + GX), y: PAD + r * (H + GY) })));
  return { pos, width, height: PAD * 2 + rows.length * H + (rows.length - 1) * GY };
}

/** Each edge's exit and entry points, spread along the bottom of its source and the top of its target. */
export function anchors(g: NonNullable<ReturnType<typeof changeGraph>>, pos: Map<string, { x: number; y: number }>) {
  // An edge that skips rows goes round the boxes in the rows it crosses, on the side of its target.
  const boxes = [...pos.values()];
  const detour = (a: { y: number }, b: { y: number }, x1: number, x2: number) => {
    const mid = boxes.filter((p) => p.y > a.y && p.y < b.y);
    if (!mid.length) return null;
    const hits = (x: number) => mid.some((p) => x > p.x - 8 && x < p.x + W + 8);
    if (!hits(x1) && !hits(x2) && !hits((x1 + x2) / 2)) return null;
    const right = x2 >= x1;
    const sx = right ? Math.max(...mid.map((p) => p.x + W)) + 14 : Math.min(...mid.map((p) => p.x)) - 14;
    return { sx, top: Math.min(...mid.map((p) => p.y)), bottom: Math.max(...mid.map((p) => p.y)) + H };
  };
  const cx = (id: string) => pos.get(id)!.x;
  // Where an edge comes from as seen by its target: its detour's side when it goes round a row.
  const approach = (i: number) => {
    const e = g.edges[i], a = pos.get(e.from)!, b = pos.get(e.to)!;
    return detour(a, b, a.x + W / 2, b.x + W / 2)?.sx ?? a.x;
  };
  const spread = (key: "from" | "to", other: "from" | "to") => {
    const at = new Map<number, number>();
    const by = new Map<string, number[]>();
    g.edges.forEach((e, i) => by.set(e[key], [...(by.get(e[key]) ?? []), i]));
    for (const [id, is] of by) {
      is.sort((a, b) => (key === "to" ? approach(a) - approach(b) : cx(g.edges[a][other]) - cx(g.edges[b][other])));
      is.forEach((i, k) => at.set(i, pos.get(id)!.x + (W * (k + 1)) / (is.length + 1)));
    }
    return at;
  };
  const exit = spread("from", "to"), entry = spread("to", "from");
  // A label sits on the outer side of its arrowhead: left of an arrow entering the box's left half,
  // right of one entering its right half. Labels on the same side of one box stack upward.
  const side = (i: number) => (entry.get(i)! < pos.get(g.edges[i].to)!.x + W / 2 ? "left" : "right");
  const stack = new Map<number, number>();
  const seen = new Map<string, number>();
  g.edges.map((_, i) => i).filter((i) => g.edges[i].label).sort((a, b) => entry.get(a)! - entry.get(b)!).forEach((i) => {
    const key = `${g.edges[i].to}:${side(i)}`;
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    stack.set(i, k);
  });
  return g.edges.map((e, i) => {
    const a = pos.get(e.from)!, b = pos.get(e.to)!;
    const up = b.y <= a.y; // a back edge: leave from the side and come back round
    const x1 = exit.get(i)!, y1 = up ? a.y + H / 2 : a.y + H, x2 = entry.get(i)!, y2 = b.y;
    return { x1, y1, x2, y2, up, label: e.label, k: stack.get(i) ?? 0, left: side(i) === "left", via: up ? null : detour(a, b, x1, x2) };
  });
}

export function ChangeDiagram({ nodes, edges }: { nodes: ChangeNode[]; edges: ChangeEdge[] }) {
  const g = changeGraph(nodes, edges);
  if (!g) return null;
  const { pos, width, height } = layoutChanges(g);
  const lines = anchors(g, pos);
  return (
    <figure data-mr="ChangeDiagram" style={{ margin: 0, overflowX: "auto" }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="What the PR changes" style={{ display: "block", margin: "0 auto" }}>
        <defs><marker id="mr-cd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--mr-ink-3)" /></marker></defs>
        {lines.map((l, i) => {
          const dy = Math.min(40, Math.abs(l.y2 - l.y1) / 2);
          const v = l.via, r = GY / 2;
          const d = l.up ? `M${l.x1},${l.y1} C${l.x1 - 60},${l.y1} ${l.x2},${l.y2 - 40} ${l.x2},${l.y2}`
            : v ? `M${l.x1},${l.y1} C${l.x1},${l.y1 + r} ${v.sx},${v.top - r} ${v.sx},${v.top} L${v.sx},${v.bottom} C${v.sx},${v.bottom + r} ${l.x2},${l.y2 - r} ${l.x2},${l.y2}`
            : `M${l.x1},${l.y1} C${l.x1},${l.y1 + dy} ${l.x2},${l.y2 - dy} ${l.x2},${l.y2}`;
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="var(--mr-ink-3)" strokeWidth="1.5" markerEnd="url(#mr-cd-arrow)" />
              {l.label && <text x={l.left ? l.x2 - 5 : l.x2 + 5} y={l.y2 - 8 - l.k * 12} textAnchor={l.left ? "end" : "start"} fontSize="10" fill="var(--mr-ink-2)" fontFamily="var(--mr-mono)" stroke="var(--mr-tile)" strokeWidth="3" paintOrder="stroke">{l.label}</text>}
            </g>
          );
        })}
        {g.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const m = MARK[n.mark];
          return (
            <g key={n.id} data-mr="ChangeNode" data-mr-source={n.id}>
              <rect x={p.x} y={p.y} width={W} height={H} fill="var(--mr-well)" />
              {n.finding && <rect x={p.x} y={p.y + H - 3} width={W} height={3} fill="var(--mr-needs)" />}
              <foreignObject x={p.x} y={p.y} width={W} height={H}>
                <div title={n.finding ? `${n.label} · ${n.finding} finding` : n.label} style={{ height: "100%", display: "flex", alignItems: "center", gap: 6, padding: "0 8px", fontSize: 12, lineHeight: 1.2, color: n.mark === "-" ? "var(--mr-ink-3)" : "var(--mr-ink)" }}>
                  <b className="mr-mono" aria-label={m.word} style={{ flex: "none", color: m.color }}>{n.mark === "-" ? "−" : n.mark}</b>
                  <span style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere", textDecoration: n.mark === "-" ? "line-through" : undefined }}>{n.label}</span>
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
      <figcaption className="mr-dim mr-mono" style={{ fontSize: 11, marginTop: 6, textAlign: "center" }}>
        <span style={{ color: MARK["+"].color }}>+</span> new · <span style={{ color: MARK["~"].color }}>~</span> changed · <span style={{ color: MARK["-"].color }}>−</span> removed{g.nodes.some((n) => n.finding) && <> · <span style={{ display: "inline-block", width: 12, height: 3, verticalAlign: "middle", background: "var(--mr-needs)" }} /> has a finding</>}
      </figcaption>
    </figure>
  );
}

