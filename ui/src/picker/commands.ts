// Shell commands Claude suggests in a reply (MR-85), so they get a Run button: fenced shell blocks,
// inline code in a clause that says "run"/"try"/"execute" ("**Run:** `bun test`", "run `a`, then `b`"),
// inline code that is plainly a command (`npm test`, `./scripts/dev.sh`), or "$ cmd".

const SHELL = new Set(["bash", "sh", "shell", "zsh", "console", "terminal"]);

// Programs whose invocation is a command on its own, wherever it appears.
const BIN = /^(npm|npx|bun|bunx|yarn|pnpm|node|deno|git|gh|cargo|rustup|make|cd|python3?|pip3?|uv|brew|docker|kubectl|curl|sqlite3|claude|mise|tsc|vitest|pytest|ntn)\s+\S/;
const SCRIPT = /^\.{1,2}\/\S+\.(sh|py|ts|js)(\s|$)/;

/** Whether a line reads as a shell command by its shape alone. */
export function shellish(c: string): boolean {
  return BIN.test(c) || SCRIPT.test(c);
}

/** The command in a fenced block, or null when it isn't a shell block. Prompts ("$ ") are dropped;
 *  in a console block only prompt lines are commands, the rest is sample output. An unlabelled
 *  fence counts when every line is a command. */
export function fenceCommand(lang: string, lines: string[]): string | null {
  const l = lang.trim().toLowerCase();
  if (!SHELL.has(l)) {
    const body = lines.map((x) => x.trim()).filter(Boolean);
    return !l && body.length && body.every(shellish) ? body.join("\n") : null;
  }
  const prompted = lines.filter((x) => /^\s*\$ /.test(x));
  const cmd = (l === "console" || prompted.length ? prompted : lines).map((x) => x.replace(/^\s*\$ /, "")).join("\n").trim();
  return cmd || null;
}

/** The command in an inline code span, given the line's text before it; null when it isn't one. */
export function inlineCommand(code: string, before: string): string | null {
  const c = code.trim();
  if (/^\$ \S/.test(c)) return c.slice(2).trim();
  if (!c || /\n/.test(c)) return null;
  if (shellish(c)) return c;
  // The clause the span sits in: from the last sentence end, markdown emphasis removed.
  const clause = before.replace(/\*+/g, "").split(/[.!?](?:\s|$)|\n/).pop() ?? "";
  const verb = /\b(run|re-?run|try|execute)\b/i;
  // Right after the verb any span counts (`make`); further along it needs arguments, so a file or
  // identifier mentioned later in the clause doesn't.
  return /\b(run|re-?run|try|execute)\s*:?\s*$/i.test(clause) || (verb.test(clause) && /\s/.test(c)) ? c : null;
}
