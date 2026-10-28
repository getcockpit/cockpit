// Typed paths in the folder picker: `~`, `~/x`, `/x`, `.`, `..`, `./x` and `../x`, resolved against
// the current folder and normalised (`a/./b/../c` → `a/c`). Anything else is filter text (null).
// Paths under home keep their `~` form; the core expands it when a session starts.
// Windows paths work too: `C:\x` (or `C:/x`) and `\\server\share\x` come back with `\` separators.

import { segments } from "../fspath";

type Rooted = { root: string; rest: string[] };

// A path's root and the names after it, or null when it isn't absolute (or `~`).
function rooted(p: string): Rooted | null {
  if (p === "~" || /^~[\\/]/.test(p)) return { root: "~", rest: segments(p.slice(1)) };
  if (/^[A-Za-z]:([\\/]|$)/.test(p)) return { root: `${p.slice(0, 2)}\\`, rest: segments(p.slice(2)) };
  if (/^\\\\[^\\/]/.test(p)) {
    // UNC: `\\server\share` is the root; `..` never climbs above it.
    const [server, share, ...rest] = segments(p);
    return { root: `\\\\${server}${share ? `\\${share}` : ""}`, rest };
  }
  if (p.startsWith("/")) return { root: "/", rest: segments(p) };
  return null;
}

function format(root: string, out: string[]): string {
  if (root === "~") return out.length ? `~/${out.join("/")}` : "~";
  if (root === "/") return `/${out.join("/")}`;
  if (root.endsWith("\\")) return root + out.join("\\");
  return out.length ? `${root}\\${out.join("\\")}` : root;
}

export function resolveTyped(input: string, base: string, home: string): string | null {
  const t = input.trim();
  if (!/^(~([\\/]|$)|\/|\.\.?([\\/]|$)|[A-Za-z]:[\\/]|\\\\[^\\/])/.test(t)) return null;
  const full = t.startsWith(".") ? `${base.replace(/(.)[\\/]+$/, "$1") || "/"}/${t}` : t;
  const r = rooted(full);
  if (!r) return null;
  let root = r.root;
  const out: string[] = [];
  for (const p of r.rest) {
    if (p === ".") continue;
    if (p !== "..") { out.push(p); continue; }
    if (out.length) out.pop();
    else if (root === "~" && home) {
      // Climbing above home: switch to the absolute form and keep going.
      const h = rooted(home);
      if (!h) continue;
      out.push(...h.rest);
      out.pop();
      root = h.root;
    }
  }
  return format(root, out);
}
