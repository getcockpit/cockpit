import { expect, test } from "vitest";
import { fenceCommand, inlineCommand } from "./commands";

test("shell fences are commands, others aren't (MR-85)", () => {
  expect(fenceCommand("bash", ["cd ui", "bun run test"])).toBe("cd ui\nbun run test");
  expect(fenceCommand("sh", ["$ npm install"])).toBe("npm install");
  expect(fenceCommand("console", ["$ ls", "a.txt b.txt"])).toBe("ls");
  expect(fenceCommand("ts", ["const x = 1"])).toBeNull();
  expect(fenceCommand("", ["make"])).toBeNull();
  expect(fenceCommand("bash", ["  "])).toBeNull();
});

test("inline code is a command after a run verb or a prompt (MR-85)", () => {
  expect(inlineCommand("npm test", "Next: run ")).toBe("npm test");
  expect(inlineCommand("bun test", "Run: ")).toBe("bun test");
  expect(inlineCommand("./scripts/dev.sh", "then try ")).toBe("./scripts/dev.sh");
  expect(inlineCommand("$ git status", "see ")).toBe("git status");
  expect(inlineCommand("src/auth.ts:42", "edit ")).toBeNull();
  expect(inlineCommand("verifyToken", "the runner calls ")).toBeNull();
});
