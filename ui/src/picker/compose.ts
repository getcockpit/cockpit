// What the message box shows and sends beyond plain text: long pastes folded into a token, and the
// marks that make @files, /commands and those tokens stand out (in the box and in the transcript).

/** A paste this long folds into a token, as in Claude Code: the box stays readable. */
export function foldsPaste(text: string): boolean {
  return text.length > 800 || text.split("\n").length > 12;
}

export const pasteToken = (n: number, text: string) => `[Pasted text #${n} · ${text.split("\n").length} lines]`;

/** The text with every paste token still in it swapped back for what was pasted. */
export function expandPastes(text: string, pastes: Record<number, string>): string {
  return text.replace(/\[Pasted text #(\d+) · \d+ lines\]/g, (m, n) => pastes[Number(n)] ?? m);
}

/** Which pasted texts' tokens are still in the box (the rest were deleted). */
export function pastesIn(text: string): number[] {
  return [...text.matchAll(/\[Pasted text #(\d+) · \d+ lines\]/g)].map((m) => Number(m[1]));
}

export type Segment = { text: string; kind: "plain" | "file" | "command" | "paste" };

// @path, @"a path with spaces", or a paste token; `@` only at the start or after a space.
const MARK = /(^|\s)(@"[^"\n]+"|@[^\s@]+)|\[Pasted text #\d+ · \d+ lines\]/g;

/** The text cut into marked and plain runs. `/name` at the very start is a command when `isCommand` says so. */
export function segments(text: string, isCommand: (name: string) => boolean = () => true): Segment[] {
  const out: Segment[] = [];
  const push = (t: string, kind: Segment["kind"]) => { if (!t) return; const last = out.at(-1); if (last && last.kind === kind && kind === "plain") last.text += t; else out.push({ text: t, kind }); };
  let from = 0;
  const cmd = /^\/([\w:.-]+)/.exec(text);
  if (cmd && isCommand(cmd[1].toLowerCase())) { push(cmd[0], "command"); from = cmd[0].length; }
  MARK.lastIndex = from;
  for (let m; (m = MARK.exec(text));) {
    const lead = m[1] ?? "", tok = m[2] ?? m[0];
    // A trailing comma or full stop ends the sentence, not the path.
    const tail = m[2] ? /[.,;:!?)]+$/.exec(tok)?.[0] ?? "" : "";
    push(text.slice(from, m.index) + lead, "plain");
    push(tok.slice(0, tok.length - tail.length), m[2] ? "file" : "paste");
    push(tail, "plain");
    from = m.index + m[0].length;
  }
  push(text.slice(from), "plain");
  return out;
}

/** The path a file mark names: `@src/a.ts` → `src/a.ts`, `@"/a b/c"` → `/a b/c`. */
export const markPath = (mark: string) => mark.replace(/^@"?/, "").replace(/"$/, "");

/** A file's size for a chip: 912 B, 14 KB, 3.2 MB. */
export function fileSize(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/** Where a dropped or picked path goes: a mention, relative to the folder when inside it, or an attachment.
 *  Images and PDFs are attached so Claude sees them at once; folders and the folder's own files are mentioned. */
export function placeFile(f: { path: string; mime: string; dir: boolean }, cwd: string): { as: "mention"; text: string } | { as: "attach" } {
  if (!f.dir && (f.mime.startsWith("image/") || f.mime === "application/pdf")) return { as: "attach" };
  const root = cwd.replace(/\/+$/, "");
  const inside = root && f.path.startsWith(`${root}/`);
  if (f.dir || inside) {
    const p = inside ? f.path.slice(root.length + 1) : f.path;
    const shown = f.dir && !p.endsWith("/") ? `${p}/` : p;
    return { as: "mention", text: /\s/.test(shown) ? `@"${shown}"` : `@${shown}` };
  }
  return { as: "attach" };
}
