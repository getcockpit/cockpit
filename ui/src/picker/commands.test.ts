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

test("commands after a bold label, later in the clause, or by shape get Run too (MR-111)", () => {
  expect(inlineCommand("npm test", "**Run tests:** ")).toBe("npm test");
  expect(inlineCommand("bun run build", "Run `bun test`, then ")).toBe("bun run build");
  expect(inlineCommand("make", "Run ")).toBe("make");
  expect(inlineCommand("cargo test docs::", "Next: ")).toBe("cargo test docs::");
  expect(inlineCommand("./scripts/selftest.sh view", "")).toBe("./scripts/selftest.sh view");
  expect(inlineCommand("config.ts", "the run reads ")).toBeNull();
  expect(inlineCommand("open the panel", "Run it later. Then ")).toBeNull();
  expect(inlineCommand("git", "uses ")).toBeNull();
});

test("an unlabelled fence counts only when every line is a command (MR-111)", () => {
  expect(fenceCommand("", ["cd ui", "bun run test"])).toBe("cd ui\nbun run test");
  expect(fenceCommand("", ["npm test", "PASS 12 tests"])).toBeNull();
});
