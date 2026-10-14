import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { replay } from "../state/reduce";
import type { MrEvent } from "../state/types";
import { Wall } from "./Wall";

// User ask: "Add a red 'Never ask' lamp on the wall" (I109).
const ev = (id: string, mode: string): MrEvent => ({ id, session_id: null, kind: "ui.permission_mode_set", payload: { mode }, anchor: null, created_at: 1 });
const wall = (events: MrEvent[]) => renderToStaticMarkup(<Wall state={replay(events)} docs={[]} archived={0} onArchive={() => {}} onOpen={() => {}} onOpenDoc={() => {}} onStart={() => {}} onBuild={() => {}} />);

test("the wall shows a Never ask lamp only while Never ask is on", () => {
  expect(wall([ev("A", "never")])).toContain('data-mr="NeverAskLamp"');
  expect(wall([ev("A", "never"), ev("B", "auto")])).not.toContain("NeverAskLamp");
  expect(wall([])).not.toContain("NeverAskLamp");
});
