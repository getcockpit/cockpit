import { describe, expect, test } from "vitest";
import { replay } from "./reduce";
import { cadenceLabel, draftFrom, runLabel } from "../screens/Recurring";
import type { MrEvent } from "./types";

// Recurring sessions (MR-167): the core logs schedule events; the list and runs fold here.
let n = 0;
const ev = (kind: string, payload: Record<string, unknown>, session: string | null = null): MrEvent => ({ id: `E${String(++n).padStart(4, "0")}`, session_id: session, kind, payload, anchor: null, created_at: 1_000_000 + n * 1000 });
const def = { id: "a", name: "Digest", prompt: "Summarise PRs", cwd: "/r", workspace: "personal", worktree: false, cadence: { kind: "daily", at: "09:00" }, permission_mode: "default", paused: false };

describe("schedules fold from the log", () => {
  const state = replay([
    ev("ui.schedule_set", def),
    ev("ui.schedule_set", { ...def, id: "b", name: "Standup" }),
    ev("ui.session_requested", { prompt: "Summarise PRs", cwd: "/r", schedule: "a" }, "s1"),
    ev("schedule.fired", { id: "a", session: "s1", reason: "due", slot: "2026-10-19T09:00" }, "s1"),
    ev("schedule.failed", { id: "a", reason: "catchup", error: "not a folder: /r" }),
    ev("ui.schedule_set", { ...def, name: "PR digest", paused: true }),
    ev("ui.schedule_deleted", { id: "b" }),
    ev("ui.session_requested", { prompt: "by hand", cwd: "/r" }, "s2"),
    ev("ui.background_set", { mode: "always" }),
  ]);

  test("upserts keep the runs, deletes drop the schedule", () => {
    expect(Object.keys(state.schedules)).toEqual(["a"]);
    const a = state.schedules.a;
    expect(a).toMatchObject({ name: "PR digest", paused: true, permissionMode: "default", worktree: false, cadence: { kind: "daily", at: "09:00" } });
    expect(a.runs.map((r) => [r.session, r.reason, r.ok])).toEqual([["s1", "due", true], [null, "catchup", false]]);
    expect(a.runs[1].error).toBe("not a folder: /r");
  });

  test("runs link to their schedule and start unread; others don't", () => {
    expect(state.sessions.s1).toMatchObject({ schedule: "a", unread: true });
    expect(state.sessions.s2).toMatchObject({ schedule: null, unread: false });
    expect(replay([ev("ui.session_requested", { prompt: "x", cwd: "/r", schedule: "a" }, "s3"), ev("ui.run_seen", {}, "s3")]).sessions.s3.unread).toBe(false);
  });

  test("the background setting", () => {
    expect(state.background).toBe("always");
    expect(replay([]).background).toBe("schedules");
  });
});

describe("labels", () => {
  test("cadences", () => {
    expect(cadenceLabel({ kind: "daily", at: "09:00" })).toBe("Daily at 09:00");
    expect(cadenceLabel({ kind: "weekdays", at: "08:30" })).toBe("Weekdays at 08:30");
    expect(cadenceLabel({ kind: "weekly", at: "10:00", days: [1, 4] })).toBe("Mon, Thu at 10:00");
    expect(cadenceLabel({ kind: "hourly", at: "09:15", every_h: 3 })).toBe("Every 3 h from 09:15");
    expect(cadenceLabel({ kind: "hourly", at: "00:20", every_h: 1 })).toBe("Hourly at :20");
  });
  test("runs", () => {
    expect(runLabel({ at: 0, session: "s", reason: "manual", ok: true, error: null, slot: null })).toBe("run now");
    expect(runLabel({ at: 0, session: null, reason: "due", ok: false, error: "cap", slot: null })).toBe("didn't start: cap");
    expect(runLabel({ at: 0, session: "s", reason: "catchup", ok: true, error: null, slot: "2026-10-19T09:00" })).toMatch(/^caught up · due /);
  });
  test("Repeat… drafts from the session: the repo, not its worktree", () => {
    const s = replay([ev("ui.session_requested", { prompt: "Weekly usage review", cwd: "/r-worktrees/x", repo: "/r", branch: "mr/x", workspace: "w1" }, "s9")]).sessions.s9;
    expect(draftFrom(s)).toMatchObject({ prompt: "Weekly usage review", cwd: "/r", workspace: "w1", worktree: true, fromSession: "s9" });
  });
});
