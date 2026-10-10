import { describe, expect, it } from "vitest";
import { checkRow, counts, editCard, isCard, isCheck } from "./logCards";
import { groupSteps } from "../screens/Focus";
import type { TranscriptItem } from "../state/types";

type Tool = Extract<TranscriptItem, { kind: "tool" }>;
let n = 0;
const tool = (name: string, input: Record<string, unknown>, result?: unknown, isError = false): Tool =>
  ({ kind: "tool", id: `t${++n}`, toolUseId: `u${n}`, name, input, result, isError, at: n });

describe("editCard", () => {
  it("uses Claude Code's patch, with the line it starts on", () => {
    const c = editCard(tool("Edit", { file_path: "/r/ui/src/a.tsx", old_string: "x", new_string: "y" }, {
      structuredPatch: [{ oldStart: 10, newStart: 10, lines: [" keep", "-old", "+new", "+more"] }],
    }))!;
    expect(c).toMatchObject({ file: "a.tsx", where: "line 10", added: 2, removed: 1, code: " keep\n-old\n+new\n+more" });
  });

  it("falls back to the input while the edit is in flight", () => {
    const c = editCard(tool("Edit", { file_path: "/r/b.ts", old_string: "a\nb", new_string: "c" }))!;
    expect(c.code).toBe("-a\n-b\n+c");
  });

  it("shows a new file as added lines and caps long ones", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const c = editCard(tool("Write", { file_path: "/r/new.ts", content }, { type: "create", structuredPatch: [] }))!;
    expect(c).toMatchObject({ where: "new file", added: 50, more: 10 });
    expect(c.code.split("\n")).toHaveLength(40);
  });

  it("skips failed edits and other tools", () => {
    expect(editCard(tool("Edit", { file_path: "/r/a" }, "no match", true))).toBeNull();
    expect(editCard(tool("Read", { file_path: "/r/a" }))).toBeNull();
  });
});

describe("checks", () => {
  it("knows test, build and type-check commands", () => {
    for (const c of ["(cd ui && bun run test)", "cd src-tauri && cargo test docs::", "bunx tsc --noEmit -p .", "bunx vitest run x", "./scripts/selftest-view.sh"]) expect(isCheck(tool("Bash", { command: c }))).toBe(true);
    for (const c of ["git status", "grep -rn test src", "cat test.ts"]) expect(isCheck(tool("Bash", { command: c }))).toBe(false);
  });

  it("reads runner counts", () => {
    expect(counts(" Test Files  9 passed (9)\n      Tests  1 failed | 76 passed (77)\n")).toEqual({ passed: 76, failed: 1, errors: 0 });
    expect(counts("test result: ok. 40 passed; 0 failed; 0 ignored\ntest result: ok. 2 passed; 0 failed\n")).toEqual({ passed: 42, failed: 0, errors: 0 });
    expect(counts(" 12 pass\n 0 fail\n")).toEqual({ passed: 12, failed: 0, errors: 0 });
    expect(counts("src/a.ts(3,1): error TS2345: nope\nsrc/b.ts(4,1): error TS2322: nope\n")).toEqual({ passed: 0, failed: 0, errors: 2 });
  });

  it("turns a run into a checklist row", () => {
    expect(checkRow(tool("Bash", { command: "bun run test", description: "Run UI tests" }, { stdout: "Tests  77 passed (77)", stderr: "" }))).toEqual({ label: "Run UI tests", ok: true, proof: "77 passed" });
    expect(checkRow(tool("Bash", { command: "bunx tsc --noEmit" }, "x.ts(1,1): error TS1: bad", true))).toMatchObject({ ok: false, proof: "1 error" });
    expect(checkRow(tool("Bash", { command: "bun run build" }, { stdout: "built in 2s", stderr: "" }))).toMatchObject({ ok: true, proof: "exit 0" });
    expect(checkRow(tool("Bash", { command: "cargo test" }))).toMatchObject({ ok: null, proof: "running" });
  });
});

describe("transcript grouping", () => {
  it("pulls edits and checks out of folded tool runs and merges back-to-back checks", () => {
    const items: TranscriptItem[] = [
      tool("Read", { file_path: "/a" }, "x"), tool("Read", { file_path: "/b" }, "x"), tool("Grep", { pattern: "q" }, "x"),
      tool("Edit", { file_path: "/a", old_string: "1", new_string: "2" }, {}),
      tool("Bash", { command: "bun run test" }, { stdout: "Tests  3 passed (3)" }), tool("Bash", { command: "bunx tsc --noEmit" }, { stdout: "" }),
    ];
    expect(groupSteps(items).map((r) => r.kind)).toEqual(["tools", "tool", "checks"]);
    expect(isCard(items[3])).toBe(true);
  });

  it("shows cards under a plan step while still counting them as its actions", () => {
    const items = [tool("Read", { file_path: "/a" }, "x"), tool("Edit", { file_path: "/a", old_string: "1", new_string: "2" }, {})].map((t) => ({ ...t, step: "Build it" }));
    const [g] = groupSteps(items);
    expect(g.kind === "step" && [g.tools.length, g.signal.length]).toEqual([2, 1]);
  });
});
