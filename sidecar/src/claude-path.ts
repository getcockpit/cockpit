import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Which `claude` binary to drive (MR-2 finding 1). Never one bundled inside another app.
// Returns undefined to let the SDK use its own bundled copy as the last resort.
export function resolveClaude(env: Record<string, string | undefined> = process.env, home = homedir()): string | undefined {
  const isExe = (p: string) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };
  if (env.MR_CLAUDE_PATH && isExe(env.MR_CLAUDE_PATH)) return env.MR_CLAUDE_PATH;
  const native = join(home, ".local", "bin", "claude");
  if (isExe(native)) return native;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || dir.includes(".app/")) continue;
    const p = join(dir, "claude");
    if (isExe(p)) return p;
  }
  return undefined;
}
