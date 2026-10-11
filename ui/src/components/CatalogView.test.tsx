import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogView, ViewGlance } from "./CatalogView";
import doc from "../demo/multiplayer-doc.json";
import type { ViewBlock } from "../state/types";

// Every view on the real Multiplayer plan doc renders, in the pane and as a tile glance (MR-102/103).
test("every block of a real plan doc renders its view", () => {
  for (const b of Object.values(doc.blocks) as { id: string; view?: ViewBlock[] }[]) {
    const view = b.view ?? [];
    expect(view.length, b.id).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<CatalogView id={b.id} title="" blocks={view} onReply={() => {}} live />);
    for (const v of view) expect(html, `${b.id}: ${v.type}`).toContain(`data-mr="View:${v.type}"`);
    renderToStaticMarkup(<ViewGlance blocks={view} source={b.id} />);
  }
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
