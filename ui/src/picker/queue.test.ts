import { expect, test } from "vitest";
import { proseQuestion, replyOptions } from "./queue";

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
