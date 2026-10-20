import { describe, expect, test } from "vitest";
import { replay } from "./reduce";
import { renderToStaticMarkup } from "react-dom/server";
import { cadenceLabel, checkLabel, draftFrom, Editor, historyRows, runLabel } from "../screens/Recurring";
import { cadenceExpr, cronLabel, nextRuns, parseCron, toCron } from "../components/cron";
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

// MR-169: cron cadences, built from rows, and the check gate's status.
describe("cron cadences", () => {
  test("rows round-trip to the expression", () => {
    for (const e of ["*/5 9-17 * * 1-5", "0 9 * * *", "0,30 8 * * 1,4", "15 0-23/3 * * *", "0 0 1,15 * *"]) {
      const r = parseCron(e)!;
      expect(parseCron(toCron(r))).toEqual(r);
    }
    expect(toCron(parseCron("0 9 * * MON-FRI")!)).toBe("0 9 * * 1-5");
    expect(parseCron("0 9 * * 7")!.dow).toEqual({ mode: "these", values: [0] });
    for (const bad of ["* * * *", "60 * * * *", "*/0 * * * *", "5-1 * * * *", "0 9 * foo *"]) expect(parseCron(bad)).toBeNull();
  });
  test("labels", () => {
    expect(cronLabel("*/5 9-17 * * 1-5")).toBe("Every 5 min, 09–17h, Weekdays");
    expect(cronLabel("0 9 * * *")).toBe("Daily at 09:00");
    expect(cronLabel("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(cronLabel("30 8 * * 1,4")).toBe("Mon, Thu at 08:30");
    expect(cronLabel("0 * * * *")).toBe("Hourly at :00");
    expect(cronLabel("15 0-23/3 * * *")).toBe("Every 3 h from 00:15");
    expect(cronLabel("*/10 * * * *")).toBe("Every 10 min");
    expect(cadenceLabel({ kind: "cron", expr: "0 9 * * 6,0" })).toBe("Sat, Sun at 09:00");
  });
  test("the older kinds convert as the core does", () => {
    expect(cadenceExpr({ kind: "weekdays", at: "09:05" })).toBe("5 9 * * 1-5");
    expect(cadenceExpr({ kind: "weekly", at: "08:30", days: [7, 1] })).toBe("30 8 * * 1,7");
    expect(cadenceExpr({ kind: "hourly", at: "09:15", every_h: 3 })).toBe("15 0-23/3 * * *");
  });
  test("next runs (the demo's preview)", () => {
    const mon = new Date(2026, 9, 19, 9, 3).getTime();
    expect(nextRuns("*/5 9-17 * * 1-5", mon, 2).map((t) => new Date(t).getMinutes())).toEqual([5, 10]);
    expect(new Date(nextRuns("0 9 * * 1-5", new Date(2026, 9, 23, 10, 0).getTime(), 1)[0]).getDay()).toBe(1);
  });
  test("a schedule keeps its check", () => {
    const s = replay([ev("ui.schedule_set", { ...def, id: "g", check: "gh pr list" })]).schedules.g;
    expect(s.check).toBe("gh pr list");
    expect(replay([ev("ui.schedule_set", { ...def, id: "h" })]).schedules.h.check).toBeNull();
  });
  test("check status", () => {
    const now = 10 * 60_000;
    expect(checkLabel(undefined)).toBe("not checked yet");
    expect(checkLabel({ at: now - 120_000, outcome: "same", skipped: 14, error: null }, now)).toBe("checked 2m ago · no change · skipped 14×");
    expect(checkLabel({ at: now, outcome: "error", skipped: 1, error: "timed out after 60 s" }, now)).toBe("checked just now · check failed: timed out after 60 s");
  });
});

// MR-171: review mode starts the cmd+k Review for each PR that needs you.
describe("review-mode schedules", () => {
  const url = (n: number) => `https://github.com/acme/shop/pull/${n}`;
  const state = replay([
    ev("ui.schedule_set", { ...def, id: "w", name: "Watch", mode: "review", prompt: "" }),
    ev("ui.schedule_set", { ...def, id: "old" }),
    ev("schedule.fired", { id: "w", mode: "review", reason: "due", new: 0 }),
    ev("schedule.fired", { id: "w", mode: "review", reason: "due", new: 0 }),
    ev("schedule.fired", { id: "w", mode: "review", reason: "due", new: 2 }),
    ev("ui.session_requested", { prompt: `/review ${url(59)}`, cwd: "/r", kind: "review", schedule: "w" }, "r1"),
    ev("schedule.review_started", { id: "w", url: url(59), number: 59, title: "Pagination", head: "h1", session: "r1" }, "r1"),
    ev("schedule.review_started", { id: "w", url: url(61), number: 61, title: "Search", head: "h2", session: "r2" }, "r2"),
    ev("ui.auto_review_started", { url: url(70), head: "h7" }, "a1"),
  ]);

  test("mode folds, missing means prompt", () => {
    expect(state.schedules.w.mode).toBe("review");
    expect(state.schedules.old.mode).toBe("prompt");
  });

  test("started reviews list under their run; both features' heads are shared", () => {
    const runs = state.schedules.w.runs;
    expect(runs.map((r) => r.reviews?.map((x) => x.number))).toEqual([[], [], [59, 61]]);
    expect(runs[2].reviews![0]).toMatchObject({ session: "r1", title: "Pagination", url: url(59) });
    expect(state.reviewStarts).toEqual([`${url(59)}@h1`, `${url(61)}@h2`, `${url(70)}@h7`]);
    expect(state.sessions.r1).toMatchObject({ kind: "review", schedule: "w" });
  });

  test("labels: nothing new, started, folded quiet runs", () => {
    const [quiet, , busy] = state.schedules.w.runs;
    expect(runLabel(quiet)).toBe("on time · nothing new");
    expect(runLabel(busy)).toBe("on time · started 2 reviews (#59, #61)");
    expect(runLabel({ ...quiet, ok: false, url: url(62), error: "not a folder" })).toBe("didn't start #62: not a folder");
    const rows = historyRows(state.schedules.w.runs);
    expect(rows.map((r) => [r.run.reviews?.length, r.folded])).toEqual([[2, 1], [0, 2]]);
    const now = 10 * 60_000;
    expect(checkLabel({ at: now, outcome: "nothing", skipped: 3, error: null }, now, "review")).toBe("checked just now · nothing new");
    expect(checkLabel({ at: now, outcome: "queued", skipped: 1, error: null, waiting: 2 }, now, "review")).toBe("checked just now · 2 waiting for a free session");
  });
});

describe("the editor's mode choice", () => {
  const base = replay([]);
  const html = (initial: Record<string, unknown>) => renderToStaticMarkup(<Editor state={base} initial={initial} onCancel={() => {}} onSaved={() => {}} />);

  test("prompt mode shows the prompt, check and permission fields", () => {
    const h = html({ name: "Digest", prompt: "Summarise", cwd: "/r" });
    expect(h).toContain('aria-label="Each run"');
    expect(h).toMatch(/role="radio" aria-checked="true"[^>]*>Run a prompt</);
    expect(h).toContain('aria-label="Prompt"');
    expect(h).toContain('data-mr="ScheduleCheckField"');
    expect(h).toContain('aria-label="Ask before"');
    expect(h).not.toContain('data-mr="ScheduleRepo"');
  });

  test("review mode hides them and shows the folder's repo", () => {
    const h = html({ name: "Watch", mode: "review", prompt: "", cwd: "~/go/github.com/globex/forge" });
    expect(h).toMatch(/role="radio" aria-checked="true"[^>]*>Start a review for each PR that needs me</);
    expect(h).not.toContain('aria-label="Prompt"');
    expect(h).not.toContain('data-mr="ScheduleCheckField"');
    expect(h).not.toContain('aria-label="Ask before"');
    expect(h).toContain('data-mr="ScheduleRepo"');
    expect(h).toContain("Looking up its GitHub repo…");
    expect(h).toContain("stops for you before anything is posted to GitHub");
    // No prompt needed: the submit key is live with a name and a folder.
    expect(h).toMatch(/<button type="submit" class="mr-key" data-tone="primary">Schedule it<\/button>/);
  });
});
