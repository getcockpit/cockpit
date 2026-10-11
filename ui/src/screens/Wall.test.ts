import { expect, test } from "vitest";
import { replay } from "../state/reduce";
import { inReviewTray, resetLabel, tileNote } from "./Wall";
import type { TileSpec } from "../picker/pick";

// God-mode mark: the header showed "5-hour 10% · Week 64%" with no hint of when either limit resets.
test("both limit windows carry their reset time, shown as a short countdown", () => {
  const now = Date.UTC(2026, 9, 10, 12, 0) / 1000;
  const st = replay([{ id: "L1", session_id: null, kind: "sidecar.limits", payload: { available: true, five_hour: { utilization: 0.1, resetsAt: now + 2 * 3600 + 14 * 60 }, seven_day: { utilization: 0.64, resetsAt: now + 3 * 86400 } }, anchor: null, created_at: 1 }]);
  expect(st.usage.weeklyResetsAt).toBe(now + 3 * 86400);
  expect(resetLabel(st.usage.resetsAt, now * 1000)?.short).toBe("2h 14m");
  expect(resetLabel(now + 25 * 60, now * 1000)?.short).toBe("25m");
  expect(resetLabel(st.usage.weeklyResetsAt, now * 1000)?.short).toMatch(/^\D{2,}/);
  expect(resetLabel(st.usage.weeklyResetsAt, now * 1000)?.full).toMatch(/^Resets /);
  expect(resetLabel(null)).toBeNull();
});

// God-mode mark: a working tile spent a line on the running bash command, repeating the step the
// track already names. That line now only shows what Claude asks or wants, or where it stopped.
test("a working tile drops its activity line; asks and permission requests keep it", () => {
  const tile = (state: TileSpec["state"], doing: string): TileSpec => ({ state, step: "Step 4 of 5", progress: 0.8, progressLabel: "80%", doing });
  expect(tileNote(tile("almost", "Running the full suite"))).toBe("");
  expect(tileNote(tile("working", "Bash: bun run test"))).toBe("");
  expect(tileNote(tile("starting", "Starting…"))).toBe("");
  expect(tileNote(tile("needs_you", "Wants to use Bash"))).toBe("Wants to use Bash");
  expect(tileNote(tile("needs_you", "Asks: Where should the limiter live?"))).toBe("Asks: Where should the limiter live?");
  expect(tileNote(tile("interrupted", "Stopped when the app closed."))).toBe("Stopped when the app closed.");
});

// God-mode mark: "‖ Waiting · Fix Show the intro button · 1 file · Done ✓" sat in the Ready to review
// tray. A session waiting for your next step belongs with the running ones, labelled on its tile.
test("a waiting (idle) session stays in the running grid; finished work goes to the review tray", () => {
  const tile = (state: TileSpec["state"]): TileSpec => ({ state, step: "Your turn", progress: null, progressLabel: "", doing: "" });
  expect(inReviewTray(tile("idle"))).toBe(false);
  expect(inReviewTray(tile("working"))).toBe(false);
  expect(inReviewTray(tile("needs_you"))).toBe(false);
  expect(inReviewTray(tile("done"))).toBe(true);
  expect(inReviewTray(tile("interrupted"))).toBe(true);
  expect(inReviewTray(tile("error"))).toBe(true);
});
