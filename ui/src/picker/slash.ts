import type { CommandRow } from "../state/types";

// Slash commands in the message box (MR-87): which rows the / menu offers, and where a typed command goes.

// Claude Code's own terminal screens that the SDK doesn't offer at all: they only make sense in its terminal.
const TERMINAL_ONLY = new Set(["login", "logout", "theme", "permissions", "hooks", "ide", "terminal-setup", "vim", "status", "statusline", "memory", "add-dir", "bug", "feedback", "privacy-settings", "release-notes", "upgrade", "install-github-app", "plugin", "plugins"]);
// Commands the app answers itself, with its own visual.
const NATIVE = new Set(["mcp", "model"]);

/** The command name being typed: "/mc" → "mc"; null once there's a space (arguments) or no slash. */
export function typedCommand(text: string): string | null {
  const m = /^\/([^\s]*)$/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Menu rows for what's typed: name prefix first, then name or description contains it. At most `max`. */
export function matchCommands(rows: CommandRow[], typed: string, max = 8): CommandRow[] {
  const q = typed.toLowerCase();
  const seen = new Set<string>();
  const uniq = rows.filter((r) => (seen.has(r.name) ? false : (seen.add(r.name), true)));
  const rank = (r: CommandRow) => {
    const n = r.name.toLowerCase(), short = n.split(":").pop()!;
    if (!q) return r.skill ? 1 : 2; // nothing typed yet: skills first, they're yours
    if (n === q || r.aliases.includes(q)) return 0;
    if (n.startsWith(q) || short.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    if (r.description.toLowerCase().includes(q)) return 3;
    return 9;
  };
  return uniq.map((r) => ({ r, k: rank(r) })).filter((x) => x.k < 9).sort((a, b) => a.k - b.k || a.r.name.length - b.r.name.length || a.r.name.localeCompare(b.r.name)).slice(0, max).map((x) => x.r);
}

export type SlashRoute =
  | { to: "send" } // Claude Code runs it (skills, /compact, /context…)
  | { to: "native"; name: "mcp" | "model" } // the app shows it
  | { to: "terminal"; command: string } // needs Claude Code's own terminal
  | { to: "unknown"; name: string }; // not a command this session knows

/** Where a sent message that starts with / goes. Plain messages, and anything before the command list is known, are sent. */
export function routeSlash(text: string, rows: CommandRow[]): SlashRoute {
  const m = /^\/([\w:.-]+)(\s[\s\S]*)?$/.exec(text.trim());
  if (!m) return { to: "send" };
  const name = m[1].toLowerCase(), args = (m[2] ?? "").trim();
  const row = rows.find((r) => r.name === name || r.aliases.includes(name));
  if (NATIVE.has(name) && !args && (!row || row.builtin || !row.skill)) return { to: "native", name: name as "mcp" | "model" };
  if (row) return row.terminal ? { to: "terminal", command: text.trim() } : { to: "send" };
  if (TERMINAL_ONLY.has(name)) return { to: "terminal", command: text.trim() };
  // A path like /usr/bin or a list we haven't loaded yet: let Claude have it.
  if (!rows.length || name.includes(".")) return { to: "send" };
  return { to: "unknown", name };
}
