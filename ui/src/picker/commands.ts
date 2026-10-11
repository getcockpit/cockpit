// Shell commands Claude suggests in a reply (MR-85), so they get a Run button: fenced shell blocks,
// and inline code right after "run"/"try"/"execute" ("Run `bun test`") or written as "$ cmd".

const SHELL = new Set(["bash", "sh", "shell", "zsh", "console", "terminal"]);

/** The command in a fenced block, or null when it isn't a shell block. Prompts ("$ ") are dropped;
 *  in a console block only prompt lines are commands, the rest is sample output. */
export function fenceCommand(lang: string, lines: string[]): string | null {
  const l = lang.trim().toLowerCase();
  if (!SHELL.has(l)) return null;
  const prompted = lines.filter((x) => /^\s*\$ /.test(x));
  const cmd = (l === "console" || prompted.length ? prompted : lines).map((x) => x.replace(/^\s*\$ /, "")).join("\n").trim();
  return cmd || null;
}

/** The command in an inline code span, given the text right before it; null when it isn't one. */
export function inlineCommand(code: string, before: string): string | null {
  const c = code.trim();
  if (/^\$ \S/.test(c)) return c.slice(2).trim();
  if (!c || /\n/.test(c) || !/\b(run|re-?run|try|execute)\s*:?\s*$/i.test(before)) return null;
  return c;
}
