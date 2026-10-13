import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogView, ChangeList, ViewGlance } from "./CatalogView";
import doc from "../demo/fixtures/plan-doc.json";
import type { ViewBlock } from "../state/types";

// Every view on the demo plan doc renders, in the pane and as a tile glance (MR-102/103).
test("every block of a plan doc renders its view", () => {
  for (const b of Object.values(doc.blocks) as { id: string; view?: ViewBlock[] }[]) {
    const view = b.view ?? [];
    expect(view.length, b.id).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<CatalogView id={b.id} title="" blocks={view} onReply={() => {}} live />);
    for (const v of view) expect(html, `${b.id}: ${v.type}`).toContain(`data-mr="View:${v.type}"`);
    renderToStaticMarkup(<ViewGlance blocks={view} source={b.id} />);
  }
  const types = new Set(Object.values(doc.blocks).flatMap((b) => (b.view ?? []).map((v) => v.type)));
  expect([...types].sort()).toEqual(["cards", "checklist", "compare", "decision", "lanes", "matrix", "novelty", "phases", "progress", "risks", "scope", "stats", "steps", "takeaway"]);
});

test("a decision says when it overrode the recommendation, and phases add up", () => {
  const html = renderToStaticMarkup(<CatalogView id="x" title="" onReply={() => {}} live={false} blocks={[
    { type: "decision", chosen: "Async doc review", recommended: "Pair on a session", rejected: ["Pair on a session"] },
    { type: "decision", chosen: "Relay", recommended: "relay" },
    { type: "phases", items: [{ name: "One", min: 4, max: 5 }, { name: "Two", min: 3 }] },
    { type: "matrix", cols: ["P1"], rows: [{ label: "doc.*", cells: ["yes"] }, { label: "sidecar.*", cells: ["redacted"] }] },
  ]} />);
  expect(html.match(/Chosen over the recommendation/g)?.length).toBe(1);
  expect(html).toContain("7–8 days");
  expect(html).toContain("redacted");
});

// A PR overview: Claude repeats the mark in each label ("+ paging"). Grouped, every change
// lands under New / Changed / Removed with its mark shown once; in flow order it's one row each.
test("a change list shows each mark once, grouped or in flow order", () => {
  const nodes = [{ label: "+ paging (Limit/New/Encode/Decode)", mark: "+" }, { label: "~ apikey.List", mark: "~" }, { label: "~ ipo.List", mark: "~" }, { label: "- CountIPORecords query", mark: "-" }];
  const grouped = renderToStaticMarkup(<ChangeList nodes={nodes} grouped />);
  expect(grouped).toContain("New · 1");
  expect(grouped).toContain("Changed · 2");
  expect(grouped).toContain("Removed · 1");
  expect(grouped).not.toMatch(/>[~+-] /);
  const flow = renderToStaticMarkup(<CatalogView id="x" title="" onReply={() => {}} live={false} blocks={[{ type: "change_graph", nodes }]} />);
  expect(flow.match(/data-mr="ChangeRow"/g)?.length).toBe(4);
  expect(flow).not.toContain("→");
});
