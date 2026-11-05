import { expect, test } from "vitest";
import { needsQueue, proseQuestion, replyOptions } from "./queue";
import type { Doc } from "../state/docs";

test("finds the question at the end of a turn", () => {
  expect(proseQuestion("Done. Here's what changed:\n1. A\n2. B\nWant me to open a PR, or keep going on the follow-ups?")).toBe("Want me to open a PR, or keep going on the follow-ups?");
  expect(proseQuestion("I made the change. Should I run a narrower test file instead?")).toBe("Should I run a narrower test file instead?");
});

test("turns a question into quick replies", () => {
  expect(replyOptions("Want me to open a PR, or keep going on the follow-ups?")).toEqual(["Open a PR", "Keep going on the follow-ups"]);
  expect(replyOptions("Should I run a narrower test file instead?")).toEqual(["Yes, go ahead", "No"]);
  expect(replyOptions("Should I use Redis, Postgres or memory?")).toEqual(["Use Redis", "Postgres", "Memory"]);
  expect(replyOptions("What should the export be called?")).toEqual([]);
  expect(replyOptions("Let me know if you want me to go ahead or adjust anything first?")).toEqual(["Go ahead", "Adjust anything first"]);
});

import { cleanTitle } from "./title";
test("session titles drop the scaffolding", () => {
  expect(cleanTitle("Plan this with me before any code: CSV export for invoices. Write the plan as a working doc…")).toBe("CSV export for invoices");
  expect(cleanTitle('Side thread about the session "Fix login" (working in /x). Without changing anything…')).toBe("About “Fix login”");
  expect(cleanTitle("a ".repeat(60)).endsWith("…")).toBe(true);
  expect(cleanTitle("")).toBe("Untitled");
});

test("a plan doc with open questions needs you once, without lifting its questions onto the Wall", () => {
  const q = (id: string, decision: string | null) => ({ id, section: "question", status: "", takeaway: id, key: "", body: "", data: null, order: 0, decision, updated: "" });
  const d = { id: "d1", title: "Plan", session_id: null, version: 1, blocks: { a: q("a", null), b: q("b", null), c: q("c", "Yes") }, pending_notes: [], pending_changes: [] } as unknown as Doc;
  expect(needsQueue([], [d])).toEqual([{ kind: "doc", key: "doc:d1", d, open: 2, at: 0 }]);
  expect(needsQueue([], [{ ...d, blocks: { c: q("c", "Yes") } } as unknown as Doc])).toEqual([]);
});
