import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaude } from "./claude-path";

function fakeBin(dir: string) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "claude");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  return p;
}

test("skips claude bundled inside an .app and prefers the native install", () => {
  const root = mkdtempSync(join(tmpdir(), "mr-cp-"));
  const appBin = fakeBin(join(root, "Other.app/Contents/Resources/bin"));
  const native = fakeBin(join(root, "home/.local/bin"));
  expect(resolveClaude({ PATH: join(root, "Other.app/Contents/Resources/bin") }, join(root, "home"))).toBe(native);
  expect(appBin).not.toBe(native);
});

test("MR_CLAUDE_PATH wins, and nothing found means no Claude Code", () => {
  const root = mkdtempSync(join(tmpdir(), "mr-cp-"));
  const custom = fakeBin(join(root, "custom"));
  expect(resolveClaude({ MR_CLAUDE_PATH: custom, PATH: "" }, join(root, "nohome"))).toBe(custom);
  expect(resolveClaude({ PATH: join(root, "Other.app/bin") }, join(root, "nohome"))).toBeUndefined();
});
