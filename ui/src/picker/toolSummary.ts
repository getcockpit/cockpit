// One-line, human summary of a tool call for the transcript (god-mode mark: raw commands were unreadable).
// The raw input stays available when the row is expanded.

const base = (p: unknown) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
const files = (args: string[]) => args.filter((a) => !a.startsWith("-") && /[./]/.test(a) && !/^\d/.test(a)).map(base);
const list = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, 2).join(", ")} +${xs.length - 2}` : xs.join(", "));

// One shell step → a short phrase, or null if we have nothing better than the raw text.
function step(cmd: string): string | null {
  const words = cmd.trim().replace(/\s*\d?>\s*\/dev\/null/g, "").split(/\s+/).filter(Boolean);
  while (words[0] && /^\w+=/.test(words[0])) words.shift(); // env assignments
  const [head, sub, ...rest] = words;
  if (!head) return null;
  const args = [sub, ...rest].filter(Boolean) as string[];
  switch (head) {
    case "cat": case "head": case "tail": case "sed": case "less": case "wc": {
      const f = files(args);
      return f.length ? `read ${list(f)}` : null;
    }
    case "ls": case "find": case "tree": return "list files";
    case "grep": case "rg": case "ag": return "search code";
    case "cd": return null;
    case "git": return sub ? `git ${sub}` : "git";
    case "gh": return sub ? `gh ${sub}${rest[0] && !rest[0].startsWith("-") ? ` ${rest[0]}` : ""}` : "gh";
    case "bun": case "npm": case "pnpm": case "yarn": case "bunx": case "npx": case "cargo": {
      const what = args.find((a) => /^(test|build|install|tsc|vitest|check|clippy|dev)$/.test(a));
      const say: Record<string, string> = { test: "run tests", vitest: "run tests", build: "build", install: "install packages", tsc: "type-check", check: "check", clippy: "lint", dev: "start dev server" };
      return what ? say[what] : `${head} ${sub ?? ""}`.trim();
    }
    case "mkdir": return "make folder";
    case "rm": return `delete ${list(files(args)) || "files"}`;
    case "mv": case "cp": return `${head === "mv" ? "move" : "copy"} ${list(files(args))}`.trim();
    default: return head;
  }
}

export function summarizeTool(name: string, input: Record<string, unknown>): string {
  const n = name.replace(/^mcp__\w+?__/, "");
  if (n === "Bash") {
    if (typeof input.description === "string" && input.description.trim()) return input.description.trim();
    const parts = String(input.command ?? "").split(/;|&&|\|\||\|/).map(step).filter((x): x is string => !!x);
    const uniq = [...new Set(parts)];
    const line = uniq.length ? uniq.join(" · ") : String(input.command ?? "");
    return line.charAt(0).toUpperCase() + line.slice(1);
  }
  if (n === "Read") return `Read ${base(input.file_path)}`;
  if (n === "Edit" || n === "MultiEdit") return `Edit ${base(input.file_path)}`;
  if (n === "Write") return `Write ${base(input.file_path)}`;
  if (n === "Grep") return `Search for “${input.pattern}”${input.path ? ` in ${base(input.path)}` : ""}`;
  if (n === "Glob") return `Find ${input.pattern}`;
  if (n === "TodoWrite" || n === "plan_set") return "Update plan";
  if (n === "render_view") return `Show ${String(input.title ?? "a view")}`;
  if (n === "WebFetch") return `Fetch ${String(input.url ?? "").replace(/^https?:\/\//, "").split("/")[0]}`;
  if (n === "WebSearch") return `Search web: ${input.query}`;
  const d = input.description ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? "";
  return String(d);
}
