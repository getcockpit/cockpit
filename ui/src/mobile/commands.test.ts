import { describe, expect, test } from "vitest";
import { allow, answer, answered, deny, interrupt, reply, start } from "./commands";
import type { PendingAsk } from "../state/types";

const perm: Extract<PendingAsk, { kind: "permission" }> = { kind: "permission", requestId: "r1", tool: "Bash", input: { command: "ls" }, suggestions: null, reason: null, at: 0 };
const q: Extract<PendingAsk, { kind: "question" }> = {
  kind: "question", requestId: "r2", at: 0, input: { questions: [] },
  questions: [
    { question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] },
    { question: "Which parts?", header: "Parts", multiSelect: true, options: [{ label: "API", description: "" }, { label: "UI", description: "" }] },
  ],
};

// The phone sends exactly what the desktop would (screens/AskRow.tsx), in the Mac's allowlist shape.
describe("phone commands", () => {
  test("allow and deny match the desktop's decisions", () => {
    expect(allow("s", perm)).toEqual({ kind: "permission_response", args: { session: "s", request_id: "r1", decision: { behavior: "allow", updatedInput: { command: "ls" } } } });
    expect(deny("s", perm).args).toMatchObject({ decision: { behavior: "deny", message: "Denied from the phone." } });
    expect(deny("s", perm, "  not now ").args).toMatchObject({ decision: { message: "not now" } });
  });

  test("answers need a pick per question; several picks are joined", () => {
    expect(answered(q, { "Which DB?": ["Postgres"] })).toBe(false);
    const picks = { "Which DB?": ["Postgres"], "Which parts?": ["API", "UI"] };
    expect(answered(q, picks)).toBe(true);
    expect(answer("s", q, picks)).toEqual({ kind: "answer_question", args: { session: "s", request_id: "r2", input: { questions: [] }, answers: { "Which DB?": "Postgres", "Which parts?": "API, UI" } } });
  });

  test("replies, interrupts and starts carry ids, never paths", () => {
    expect(reply("s", "  go on ")).toEqual({ kind: "send_prompt", args: { session: "s", text: "go on" } });
    expect(interrupt("s")).toEqual({ kind: "interrupt", args: { session: "s" } });
    expect(start("personal", "a1b2", " fix it ")).toEqual({ kind: "start_session", args: { workspace_id: "personal", repo_id: "a1b2", prompt: "fix it" } });
  });
});
