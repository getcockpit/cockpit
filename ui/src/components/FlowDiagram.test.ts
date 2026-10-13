import { expect, test } from "vitest";
import type { Diagram } from "../state/types";
import { edgeLabelAt, layout } from "./FlowDiagram";

// God-mode mark (2026-10-10): a launch diagram drew every edge label at the same height,
// so the two labels fanning out of "Pick prod host" sat on top of each other and the long edges'
// labels landed under the nodes they crossed.
const LAUNCH: Diagram = {
  title: "Pick prod host before launch work",
  nodes: [
    { id: "a", label: "Sign-in, catalogue, checkout, emails done", kind: "done" },
    { id: "b", label: "Pick prod host: Render or Fly", kind: "decision" },
    { id: "c", label: "Fix link, env var, secret name", kind: "step" },
    { id: "d", label: "Payout verification takes 10 days", kind: "risk" },
    { id: "e", label: "Switch Stripe and email to live", kind: "step" },
    { id: "f", label: "Terms and privacy pages are dead links", kind: "risk" },
    { id: "g", label: "Set up hosting, secrets, domain", kind: "step" },
    { id: "h", label: "Launch-ready", kind: "done" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c", label: "after choosing host" },
    { from: "b", to: "d", label: "start account now" },
    { from: "c", to: "g" },
    { from: "e", to: "g" },
    { from: "g", to: "h" },
    { from: "d", to: "h", label: "gates release" },
    { from: "f", to: "h", label: "before launch" },
  ],
};

type Box = { l: number; r: number; t: number; b: number };
const hit = (p: Box, q: Box) => p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b;

test("edge labels overlap neither each other nor any node", () => {
  const pos = layout(LAUNCH);
  const labels: Box[] = LAUNCH.edges.filter((e) => e.label).map((e) => {
    const { x, y } = edgeLabelAt(LAUNCH, pos.get(e.from)!, pos.get(e.to)!);
    const w = e.label!.length * 6;
    return { l: x - w / 2, r: x + w / 2, t: y - 9, b: y + 3 };
  });
  const nodes: Box[] = [...pos.values()].map((p) => ({ l: p.x, r: p.x + 168, t: p.y, b: p.y + 44 }));
  labels.forEach((p, i) => {
    labels.slice(i + 1).forEach((q) => expect(hit(p, q)).toBe(false));
    nodes.forEach((n) => expect(hit(p, n)).toBe(false));
  });
});
