import { expect, test } from "vitest";
import { replay } from "../state/reduce";
import { inReviewTray, resetLabel, tileNote, tileStep } from "./Wall";
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

// God-mode mark: a waiting tile ("Shareable macOS installer", Step 4 of 5) showed the background
// task, the last Bash command (`grep -c "I66" docs/DECISIONS.md; python3 - <<'EOF'…`) and an activity
// sparkline. A tile shows no activity at all; its caption names the plan step being worked on.
test("a waiting tile shows no activity line, and its caption is the current plan step's name", () => {
  const tile = (state: TileSpec["state"], doing: string): TileSpec => ({ state, step: "Step 4 of 5", progress: 0.6, progressLabel: "60%", doing });
  expect(tileNote(tile("idle", "Bash: grep -c \"I66\" docs/DECISIONS.md; python3 - <<'EOF'"))).toBe("");
  expect(tileNote(tile("done", "Bash: git commit"))).toBe("");
  expect(tileNote(tile("error", "Bash: bun run build"))).toBe("");
  const todos = [
    { content: "Write package.sh", status: "completed" as const },
    { content: "Write INSTALL.md", status: "completed" as const },
    { content: "Record the decision", status: "completed" as const },
    { content: "Rebuild the DMG", activeForm: "Rebuilding the DMG with the packaged flag", status: "in_progress" as const },
    { content: "Merge", status: "pending" as const },
  ];
  expect(tileStep(todos, "Step 4 of 5")).toBe("Rebuilding the DMG with the packaged flag");
  expect(tileStep(todos.map((t, i) => (i === 3 ? { content: t.content, status: "pending" as const } : t)), "Step 4 of 5")).toBe("Rebuild the DMG");
  expect(tileStep(todos.map((t) => ({ ...t, status: "completed" as const })), "Ready to review")).toBe("Ready to review");
  expect(tileStep([], "Your turn")).toBe("Your turn");
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
