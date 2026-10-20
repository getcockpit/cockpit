import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { replay } from "../state/reduce";
import type { Doc } from "../state/docs";
import type { MrEvent } from "../state/types";
import { Wall } from "./Wall";

// God-mode mark on DocGroup ("WS3 → forge migration plan", one build session): "this looks ugly. I loved
// the thin thing on top before. also those design doc blocks being in its own row is pretty nice".
// MR-172 had stacked the doc header (title / meta / goal) and squeezed the group to one tile wide.
test("a doc group takes its own row under a one-line doc header", () => {
  const goal = { id: "goal_1", section: "goal", status: "", takeaway: "Move WS3's glue, workflows and email out of the standalone GCP service into forge; Acme keeps monitors + signals.", key: "", body: "", data: {}, order: 1, decision: null, updated: "" };
  const doc: Doc = { id: "doc_01m50s1fge", title: "WS3 → forge migration plan", session_id: "p0", version: 2, blocks: { goal_1: goal }, pending_notes: [], pending_changes: [], build_sessions: ["S1"] };
  const ev: MrEvent = { id: "A1", session_id: "S1", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-1" }, anchor: null, created_at: 1 };
  const html = renderToStaticMarkup(<Wall state={replay([ev])} docs={[doc]} archived={0} onArchive={() => {}} onOpen={() => {}} onOpenDoc={() => {}} onStart={() => {}} onBuild={() => {}} />);
  const group = html.match(/<div data-mr="DocGroup"[^>]*>/)?.[0] ?? "";
  expect(group).toContain("grid-column:1 / -1");
  expect(group).not.toContain("--mr-span");
  // The header is one row: tag, title, goal, meta side by side.
  const header = html.match(/data-mr="DocTile"[^>]*>.*?<div class="mr-tbody"[^>]*>/)?.[0] ?? "";
  expect(header).toContain("flex-direction:row");
  expect(html).toMatch(/▤ doc<\/span><strong[^>]*>WS3 → forge migration plan<\/strong><span[^>]*>Move WS3/);
});
