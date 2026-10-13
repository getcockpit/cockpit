import { expect, test } from "vitest";
import { addressNote, isoWeek, suggest } from "./suggest";
import { replay } from "../state/reduce";
import type { MrEvent } from "../state/types";
import type { Doc } from "../state/docs";

const ev = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = "s"): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: 1 });

test("never repeats the needs-you queue; ranks requested changes first, honours dismissals", () => {
  const state = replay([
    ev("A1", "ui.session_requested", { prompt: "fix it", cwd: "/w" }),
    ev("A2", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" } }] } } }),
    ev("A3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "done" } }),
  ]);
  const doc: Doc = { id: "d1", title: "Plan", session_id: null, version: 1, pending_notes: [], pending_changes: [], blocks: { q: { id: "q", section: "question", status: "", takeaway: "How loud?", key: "", body: "", data: null, order: 1, decision: null, updated: "" } } };
  const prs = { review: [{ number: 482, title: "checkout retries", url: "u", updatedAt: "" }], mine: [{ number: 4507, title: "infra", url: "v", updatedAt: "", reviewDecision: "CHANGES_REQUESTED" }] };
  const all = suggest(state, [doc], prs, new Set());
  // The doc's open question is in the queue, so it's not suggested again.
  expect(all.map((x) => x.label)).toEqual(["Address", "Review", "Start review"]);
  const after = suggest(state, [doc], prs, new Set([all[0].id]));
  expect(after.map((x) => x.label)).toEqual(["Review", "Start review"]);
});

test("suggests Address for threads waiting on you, not for PRs already being addressed", () => {
  const mine = [
    { number: 7, title: "waits", url: "https://github.com/a/b/pull/7", updatedAt: "", unresolved: 2, waiting: 2 },
    { number: 8, title: "replied", url: "https://github.com/a/b/pull/8", updatedAt: "", unresolved: 1, waiting: 0 },
    { number: 9, title: "busy", url: "https://github.com/a/b/pull/9", updatedAt: "", waiting: 1 },
  ];
  const state = replay([ev("A1", "ui.session_requested", { prompt: "/pr-address https://github.com/a/b/pull/9", cwd: "/w", kind: "address" })]);
  const out = suggest(state, [], { review: [], mine }, new Set());
  expect(out.map((x) => x.why)).toEqual(["2 threads waiting on you in PR #7"]);
  expect(addressNote(mine[0])).toBe("2 threads waiting on you");
  expect(addressNote({ ...mine[1], reviewDecision: "CHANGES_REQUESTED", isDraft: true })).toBe("changes requested · draft");
});

test("weekly usage review: owner only, once per ISO week, gone once run or dismissed", () => {
  const mon = new Date(2026, 9, 12, 9).getTime(); // Monday 2026-10-12
  const none = { review: [], mine: [] };
  expect(isoWeek(mon)).toBe("2026-W42");
  expect(isoWeek(new Date(2026, 9, 18, 23).getTime())).toBe("2026-W42"); // Sunday, same week
  expect(isoWeek(new Date(2027, 0, 1).getTime())).toBe("2026-W53");
  const empty = replay([]);
  // A shared install has no app repo: never offered.
  expect(suggest(empty, [], none, new Set(), null, mon)).toEqual([]);
  const [g] = suggest(empty, [], none, new Set(), "/repo", mon);
  expect([g.id, g.label, g.action]).toEqual(["usage-review:2026-W42", "Usage review", { kind: "usage_review", repo: "/repo" }]);
  expect(suggest(empty, [], none, new Set([g.id]), "/repo", mon)).toEqual([]);
  // Back next week.
  expect(suggest(empty, [], none, new Set([g.id]), "/repo", mon + 7 * 86_400_000)[0].id).toBe("usage-review:2026-W43");
  const ran = replay([{ id: "A1", session_id: "s", kind: "ui.session_requested", payload: { prompt: "/mr-usage-review", cwd: "/repo" }, anchor: null, created_at: mon }]);
  expect(suggest(ran, [], none, new Set(), "/repo", mon)).toEqual([]);
});
