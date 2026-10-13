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

// God-mode mark: a change overview as cards read as "+ release_update.rs / check, path choice…",
// glyphs and comma soup. Marks now show as a word on a coloured edge; a list detail is chips.
test("cards show marks as words and list details as chips", () => {
  const items = [
    { title: "release_update.rs", detail: "check, path choice, swap, events", mark: "+" },
    { title: "personal.rs", detail: "preview_merge, merge tag, set aside", mark: "~" },
    { title: "selfbuild.rs", detail: "resume marker; failure → choice card", mark: "~" },
    { title: "release.yml + package.sh", detail: "sign bundles, latest.json", mark: "~" },
    { title: "~ UpdateBanner + choice card", detail: "release variant, options" },
  ];
  const html = renderToStaticMarkup(<CatalogView id="doc_01m4vszzv0:design_1kat0k" title="" onReply={() => {}} live={false} blocks={[{ type: "cards", items }]} />);
  expect(html).toContain('data-mr="View:cards"');
  expect(html).not.toMatch(/>[~+-] </);
  expect(html.match(/>New</g)?.length).toBe(1);
  expect(html.match(/>Changed</g)?.length).toBe(4);
  expect(html).toContain(">path choice<");
  expect(html).toContain(">failure → choice card<");
  expect(html).toContain(">UpdateBanner + choice card<");
  expect(html).toContain("inset 4px 0 0 var(--mr-done)");
});
