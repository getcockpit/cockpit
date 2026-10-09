import { expect, test } from "vitest";
import { promptFor } from "./StartPicker";

test("each mode sends the right prompt to Claude Code", () => {
  expect(promptFor("review", " https://github.com/acme/platform/pull/482 ")).toBe("/review https://github.com/acme/platform/pull/482");
  expect(promptFor("address", "4507")).toBe("/pr-address 4507");
  expect(promptFor("plan", "webhook retries")).toMatch(/^Plan this with me before any code: webhook retries\./);
  expect(promptFor("blank", "fix the flaky test")).toBe("fix the flaky test");
});
