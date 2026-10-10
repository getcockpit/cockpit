import { expect, test } from "vitest";
import { fill, promptFor, unfill } from "./StartPicker";

test("each mode sends the right prompt to Claude Code", () => {
  expect(promptFor("review", " https://github.com/acme/platform/pull/482 ")).toBe("/review https://github.com/acme/platform/pull/482");
  expect(promptFor("address", "4507")).toBe("/pr-address 4507");
  expect(promptFor("plan", "webhook retries")).toMatch(/^Plan this with me before any code: webhook retries\./);
  expect(promptFor("blank", "fix the flaky test")).toBe("fix the flaky test");
});

test("your own kinds fill {text}, or append when there is none, and give the text back", () => {
  expect(fill("/triage {text} --quick", " 4412 ")).toBe("/triage 4412 --quick");
  expect(fill("Write tests for", "auth.ts")).toBe("Write tests for auth.ts");
  expect(unfill("/triage {text} --quick", "/triage 4412 --quick")).toBe("4412");
  expect(unfill("Write tests for", "Write tests for auth.ts")).toBe("auth.ts");
});
