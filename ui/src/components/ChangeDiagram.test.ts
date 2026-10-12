import { expect, test } from "vitest";
import { anchors, changeGraph, layoutChanges } from "./ChangeDiagram";

// Forge PR #27's change graph (SES per env), with the arrows /review's Step 5 DAG draws. As a flat
// chip list it read as a pile with nothing connected (god-mode report, 2026-10-12).
const NODES = [
  { id: "n1", label: "config.yaml hosts.mail", mark: "~" },
  { id: "n2", label: "env roots: ses_enabled", mark: "~" },
  { id: "n3", label: "+ SES identity (DKIM)", mark: "+" },
  { id: "n4", label: "MAIL FROM bounce", mark: "+" },
  { id: "n5", label: "ses_dns_records output", mark: "+" },
  { id: "n6", label: "Cognito email config", mark: "~", finding: "important" },
  { id: "n7", label: "API role ses:SendEmail", mark: "~" },
];
const EDGES = [
  { from: "n1", to: "n2", label: "mail_domain" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" },
  { from: "n3", to: "n5", label: "DNS" }, { from: "n2", to: "n6", label: "ses_enabled" },
  { from: "n3", to: "n6", label: "sends via" }, { from: "n3", to: "n7", label: "scoped to" },
];

test("no arrows, no diagram; arrows may name a node by label", () => {
  expect(changeGraph(NODES, [])).toBeNull();
  const g = changeGraph(NODES, [{ from: "config.yaml hosts.mail", to: "SES identity (DKIM)" }])!;
  expect(g.edges).toEqual([{ from: "n1", to: "n3", label: null }]);
  expect(g.nodes[2]).toMatchObject({ label: "SES identity (DKIM)", mark: "+" });
});

test("top-down rows, skip-row arrows go round, labels never collide", () => {
  const g = changeGraph(NODES, EDGES)!;
  const { pos } = layoutChanges(g);
  const row = (id: string) => pos.get(id)!.y;
  expect(row("n1")).toBeLessThan(row("n2"));
  expect(row("n2")).toBeLessThan(row("n3"));
  expect(new Set(["n4", "n5", "n6", "n7"].map(row)).size).toBe(1);
  const ls = anchors(g, pos);
  // env roots → Cognito skips SES's row, so it detours instead of running behind the SES box.
  const skip = ls[4], ses = pos.get("n3")!;
  expect(skip.via && (skip.via.sx > ses.x + 176 || skip.via.sx < ses.x)).toBe(true);
  // Two arrows into Cognito enter at different points, and the detour (from the right) takes the right one.
  expect(skip.x2).toBeGreaterThan(ls[5].x2);
  const boxes = ls.filter((l) => l.label).map((l) => {
    const w = l.label!.length * 6, x = l.left ? l.x2 - 5 - w : l.x2 + 5, y = l.y2 - 8 - l.k * 12;
    return { l: x, r: x + w, t: y - 9, b: y + 3 };
  });
  boxes.forEach((p, i) => boxes.slice(i + 1).forEach((q) => expect(p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b).toBe(false)));
});
