// Filesystem paths from the core, either platform's: `/Users/me/repo` or `C:\Users\me\repo` (and
// `\\server\share\repo`). Every basename, dirname or folder split in the UI goes through here, so a
// Windows path shows its last name, not the whole thing. Git's diff paths always use `/`; they work too.

const SEP = /[\\/]/;

/** The non-empty names in a path: `C:\a\b\` → ["C:", "a", "b"]. */
export const segments = (p: string): string[] => p.split(SEP).filter(Boolean);

/** The last name in a path, or "" for a root or empty path. */
export const basename = (p: string): string => segments(p).at(-1) ?? "";

/** Everything before the last name, without the trailing separator: `C:\a\b` → `C:\a`, `b` → "". */
export function dirname(p: string): string {
  const t = p.replace(/(.)[\\/]+$/, "$1");
  const m = /^(.*?)[\\/]+[^\\/]*$/.exec(t);
  if (!m) return "";
  return m[1] || t[0];
}

/** The path with `/` separators, for prefix checks that must hold on either platform. */
export const slashed = (p: string): string => p.replace(/\\/g, "/");
