import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// Which `claude` binary to drive (MR-2 finding 1). Never one bundled inside another app.
// Returns undefined when Claude Code isn't installed (see NO_CLAUDE).
export function resolveClaude(env: Record<string, string | undefined> = process.env, home = homedir(), platform = process.platform): string | undefined {
  // Windows installs claude.exe (native) or claude.cmd (npm).
  const names = platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const isExe = (p: string) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };
  if (env.MR_CLAUDE_PATH && isExe(env.MR_CLAUDE_PATH)) return env.MR_CLAUDE_PATH;
  for (const name of names) {
    const native = join(home, ".local", "bin", name);
    if (isExe(native)) return native;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || dir.includes(".app/")) continue;
    for (const name of names) {
      const p = join(dir, name);
      if (isExe(p)) return p;
    }
  }
  return undefined;
}

// How to start a resolved claude. npm on Windows installs a `claude.cmd` shim, and Node/Bun refuse to
// spawn .cmd/.bat without a shell (EINVAL since CVE-2024-27980), whose quoting would mangle JSON args
// anyway. So a shim is followed to the install it points at: the native claude.exe the package's
// postinstall puts in bin/ (or the platform package it copies from), else an older package's cli.js
// run with node. `command`+`args` prefix direct spawns; `sdk` goes into the Agent SDK's options.
export type ClaudeLaunch = { command: string; args: string[]; sdk: { pathToClaudeCodeExecutable: string; executable?: "node" } };

export function claudeLaunch(claude: string, platform = process.platform, arch = process.arch): ClaudeLaunch {
  const direct = (exe: string): ClaudeLaunch => ({ command: exe, args: [], sdk: { pathToClaudeCodeExecutable: exe } });
  if (!/\.(cmd|bat)$/i.test(claude)) return direct(claude);
  const dir = dirname(claude);
  const file = (p: string) => { try { return statSync(p).isFile() ? statSync(p).size : -1; } catch { return -1; } };
  // Package dirs: whatever the shim names (`"%dp0%\node_modules\@anthropic-ai\claude-code\..."`;
  // pnpm writes `%~dp0`), then npm's default layout next to the shim.
  const pkgs: string[] = [];
  let text = "";
  try { text = readFileSync(claude, "utf8"); } catch {}
  for (const m of text.matchAll(/%~?dp0%?\\?([^"%\r\n]*?@anthropic-ai[\\/]claude-code)[\\/]/gi)) pkgs.push(join(dir, ...m[1].split(/[\\/]/)));
  pkgs.push(join(dir, "node_modules", "@anthropic-ai", "claude-code"));
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const native = `claude-code-${platform}-${arch}`;
  for (const pkg of pkgs) {
    // bin/claude.exe is a ~500-byte script stub until postinstall copies the real binary over it.
    for (const p of [join(pkg, "bin", "claude.exe"), join(pkg, "node_modules", "@anthropic-ai", native, exe), join(pkg, "..", native, exe)]) {
      if (file(p) > 4096) return direct(p);
    }
    const cli = join(pkg, "cli.js");
    if (file(cli) >= 0) {
      // As the shim does: a node.exe beside it first, else node on PATH. Never "bun": the compiled
      // sidecar is the only bun on most machines, and the SDK would otherwise default to it.
      const local = join(dir, platform === "win32" ? "node.exe" : "node");
      const node = file(local) >= 0 ? local : "node";
      return { command: node, args: [cli], sdk: { pathToClaudeCodeExecutable: cli, executable: node as "node" } };
    }
  }
  throw new Error(`${claude} is an npm shim, but the Claude Code install it points to wasn't found. Reinstall Claude Code from https://claude.com/claude-code, then try again.`);
}

// Every request that needs claude fails with this when none is found, instead of crashing the sidecar.
export const NO_CLAUDE = "Claude Code isn't installed. Install it from https://claude.com/claude-code, then try again.";
