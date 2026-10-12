// File references Claude writes in a reply (MR-112): `src/a.ts:42`, `docs/PRD.md`, `~/x/y`. They
// render as file chips that show the file in Finder. Only the shape is judged here; the core checks
// the file exists before a chip appears.

import { shellish } from "./commands";

// Extensions that make a bare name (no slash) a file: `Cargo.toml`, `README.md`. A slash-less
// `api.start` or `0.15.2` is code or a version, not a file.
const EXT = /\.(tsx?|jsx?|mjs|cjs|rs|py|go|rb|swift|kt|java|c|h|cpp|hpp|cs|sh|zsh|md|mdx|txt|json|jsonl|ya?ml|toml|lock|css|scss|html|svg|png|jpe?g|gif|pdf|sql|sqlite|db|env|csv|log|xml|plist|dmg)$/i;

export type FileRef = { path: string; line?: number };

/** The file an inline code span names, or null when it isn't path-shaped. A trailing `:line` or
 *  `:line:col` is split off. */
export function fileRef(code: string): FileRef | null {
  const c = code.trim();
  if (!c || /\s/.test(c) || c.includes("://") || shellish(c)) return null;
  const m = /^(.+?)(?::(\d+)(?::\d+)?)?$/.exec(c);
  if (!m) return null;
  const path = m[1];
  if (/[*?<>|"'`{}()[\]$,;=]/.test(path) || path.startsWith("-") || path.endsWith(".")) return null;
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!name || !/[A-Za-z]/.test(name)) return null;
  const slashed = path.includes("/") && !/^\/+$/.test(path);
  if (!slashed && !EXT.test(name)) return null;
  return m[2] ? { path, line: Number(m[2]) } : { path };
}

/** The chip's label: the file's name, and the folder it sits in, dimmed. */
export function splitPath(path: string): { dir: string; name: string } {
  const p = path.replace(/\/+$/, "");
  const k = p.lastIndexOf("/");
  return k < 0 ? { dir: "", name: p } : { dir: p.slice(0, k + 1), name: p.slice(k + 1) + (path.endsWith("/") ? "/" : "") };
}
