import { expect, test } from "vitest";
import { suggest } from "./suggest";
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
  const prs = { review: [{ number: 482, title: "signup", url: "u", updatedAt: "" }], mine: [{ number: 4507, title: "infra", url: "v", updatedAt: "", reviewDecision: "CHANGES_REQUESTED" }] };
  const all = suggest(state, [doc], prs, new Set());
  // The doc's open question is in the queue, so it's not suggested again.
  expect(all.map((x) => x.label)).toEqual(["Address", "Review", "Start review"]);
  const after = suggest(state, [doc], prs, new Set([all[0].id]));
  expect(after.map((x) => x.label)).toEqual(["Review", "Start review"]);
});
