import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLaunch, resolveClaude } from "./claude-path";

function fakeBin(dir: string) {
  mkdirSync(dir, { recursive: true });
  // resolveClaude looks for claude.exe / claude.cmd on Windows.
  const p = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
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

// npm's global layout: <prefix>\claude.cmd beside <prefix>\node_modules\@anthropic-ai\claude-code.
function npmPrefix(shim = "@ECHO off\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n") {
  const root = mkdtempSync(join(tmpdir(), "mr-cp-"));
  const pkg = join(root, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(root, "claude.cmd"), shim);
  return { root, pkg, shim: join(root, "claude.cmd") };
}

test("a plain claude is spawned as is", () => {
  expect(claudeLaunch("/usr/local/bin/claude")).toEqual({ command: "/usr/local/bin/claude", args: [], sdk: { pathToClaudeCodeExecutable: "/usr/local/bin/claude" } });
});

test("an npm .cmd shim is followed to the native claude.exe its postinstall installed", () => {
  const { pkg, shim } = npmPrefix();
  writeFileSync(join(pkg, "bin", "claude.exe"), Buffer.alloc(8192, 1));
  const exe = join(pkg, "bin", "claude.exe");
  expect(claudeLaunch(shim, "win32", "x64")).toEqual({ command: exe, args: [], sdk: { pathToClaudeCodeExecutable: exe } });
});

test("with only the postinstall stub in bin/, the platform package's claude.exe is used", () => {
  const { root, pkg, shim } = npmPrefix();
  writeFileSync(join(pkg, "bin", "claude.exe"), "echo \"Error: claude native binary not installed.\" >&2\nexit 1\n");
  const exe = join(root, "node_modules", "@anthropic-ai", "claude-code-win32-x64", "claude.exe");
  mkdirSync(join(exe, ".."), { recursive: true });
  writeFileSync(exe, Buffer.alloc(8192, 1));
  expect(claudeLaunch(shim, "win32", "x64").command).toBe(exe);
});

test("an older npm .cmd shim runs the package's cli.js with node (a node.exe beside it first)", () => {
  const { root, pkg, shim } = npmPrefix("@ECHO off\r\nSET dp0=%~dp0\r\n\"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n");
  const cli = join(pkg, "cli.js");
  writeFileSync(cli, "");
  expect(claudeLaunch(shim, "win32", "x64")).toEqual({ command: "node", args: [cli], sdk: { pathToClaudeCodeExecutable: cli, executable: "node" } });
  writeFileSync(join(root, "node.exe"), "");
  expect(claudeLaunch(shim.replace(/cmd$/, "CMD"), "win32", "x64").command).toBe(join(root, "node.exe"));
});

test("a shim pointing somewhere pnpm-style is followed; a shim with no install behind it is an error", () => {
  const root = mkdtempSync(join(tmpdir(), "mr-cp-"));
  const pkg = join(root, "global", "5", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "cli.js"), "");
  writeFileSync(join(root, "claude.bat"), "@SETLOCAL\r\n\"%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n");
  expect(claudeLaunch(join(root, "claude.bat"), "win32", "x64").args).toEqual([join(pkg, "cli.js")]);
  writeFileSync(join(root, "empty.cmd"), "@ECHO off\r\n");
  expect(() => claudeLaunch(join(root, "empty.cmd"), "win32", "x64")).toThrow(/npm shim/);
});
