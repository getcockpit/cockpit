// @ mentions in the message box (MR-108): point Claude at a file or folder, as in Claude Code.

export type TypedMention = { start: number; query: string; quoted?: true };

/**
 * The @ being typed before the caret: "look at @src/ap" → { start: 8, query: "src/ap" }. Null when there's none.
 * An open quote takes spaces: `@"~/Library/Application Su` → { query: "~/Library/Application Su", quoted: true }.
 */
export function typedMention(text: string, caret: number): TypedMention | null {
  const before = text.slice(0, caret);
  const q = /(^|\s)@"([^"\n]*)$/.exec(before);
  if (q) return { start: q.index + q[1].length, query: q[2], quoted: true };
  const m = /(^|\s)@([^\s@"]*)$/.exec(before);
  return m ? { start: m.index + m[1].length, query: m[2] } : null;
}

const base = (p: string) => p.replace(/\/$/, "").split("/").pop()!.toLowerCase();

// Every character of q in order: "fcs" finds "Focus.tsx".
function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (const c of s) if (c === q[i] && ++i === q.length) return true;
  return !q.length;
}

/** Menu rows for a query: name prefix, then path prefix, then contains, then in-order letters. At most `max`. */
export function matchPaths(paths: string[], query: string, max = 8): string[] {
  const q = query.toLowerCase();
  // Nothing typed yet: what's at the top of the folder.
  if (!q) return paths.filter((p) => !p.replace(/\/$/, "").includes("/")).sort((a, b) => Number(!a.endsWith("/")) - Number(!b.endsWith("/")) || a.localeCompare(b)).slice(0, max);
  const rank = (p: string) => {
    const l = p.toLowerCase(), b = base(p);
    if (b.startsWith(q)) return 0;
    if (l.startsWith(q)) return 1;
    if (b.includes(q)) return 2;
    if (l.includes(q)) return 3;
    if (subsequence(q, l)) return 4;
    return 9;
  };
  const out: { p: string; k: number }[] = [];
  for (const p of paths) {
    const k = rank(p);
    if (k < 9) out.push({ p, k });
  }
  return out.sort((a, b) => a.k - b.k || a.p.length - b.p.length || a.p.localeCompare(b.p)).slice(0, max).map((x) => x.p);
}

/**
 * A query that points outside the session folder (`~/`, `../`, `./`, `/`): the folder to list and
 * the name typed in it. "~/Doc" → { dir: "~/", name: "Doc" }; a bare "~" or ".." opens that folder.
 */
export function outsideQuery(query: string): { dir: string; name: string } | null {
  if (query === "~" || query === "." || query === "..") return { dir: `${query}/`, name: "" };
  if (!/^(~\/|\.\.?\/|\/)/.test(query)) return null;
  const cut = query.lastIndexOf("/") + 1;
  return { dir: query.slice(0, cut), name: query.slice(cut) };
}

/** Menu rows for one listed folder: entries named like `name`, hidden ones only once a `.` is typed. */
export function matchDir(entries: string[], at: { dir: string; name: string }, max = 8): string[] {
  const names = entries.filter((e) => e.startsWith(at.dir)).map((e) => e.slice(at.dir.length)).filter((n) => n && (at.name.startsWith(".") || !n.startsWith(".")));
  return matchPaths(names, at.name, max).map((n) => at.dir + n);
}

/** The text with the typed @query swapped for the picked path, and where the caret goes. */
// A path with spaces goes in quotes: @"/a b/c.png".
export function insertMention(text: string, at: TypedMention, path: string): { text: string; caret: number } {
  const head = `${text.slice(0, at.start)}${/\s/.test(path) ? `@"${path}"` : `@${path}`} `;
  let rest = text.slice(at.start + 1 + (at.quoted ? 1 : 0) + at.query.length);
  if (at.quoted) rest = rest.replace(/^"/, "");
  rest = rest.replace(/^ /, "");
  return { text: head + rest, caret: head.length };
}

/** Dropped files as @ mentions, one per path; a path with spaces is quoted: @"/a b/c.png". */
export function droppedMentions(paths: string[]): string {
  return paths.map((p) => (/\s/.test(p) ? `@"${p}"` : `@${p}`)).join(" ");
}

/** The text with dropped files put where the caret is, spaced from what's around them, and the caret after them. */
export function insertDropped(text: string, start: number, end: number, paths: string[]): { text: string; caret: number } {
  const head = text.slice(0, start), rest = text.slice(end);
  const lead = head && !/\s$/.test(head) ? " " : "";
  const mid = `${lead}${droppedMentions(paths)}${/^\s/.test(rest) ? "" : " "}`;
  return { text: head + mid + rest, caret: head.length + mid.length };
}
