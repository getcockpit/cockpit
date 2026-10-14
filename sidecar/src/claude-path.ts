import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

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

// Every request that needs claude fails with this when none is found, instead of crashing the sidecar.
export const NO_CLAUDE = "Claude Code isn't installed. Install it from https://claude.com/claude-code, then try again.";
