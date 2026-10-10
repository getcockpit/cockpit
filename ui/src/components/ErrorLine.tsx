// Errors the user sees (MR-52): one short line saying what failed, never a raw dump. Tool output
// (git usage text, stack traces) is cut to its first meaningful line, known causes get plain words.
const KNOWN: [RegExp, string][] = [
  [/not a git repository/i, "This folder isn't a git repository."],
  [/merge conflict/i, "It conflicts with your other changes, so nothing was applied."],
  [/unknown session/i, "That session isn't running any more. Resume it first."],
  [/not logged in|\/login/i, "Claude Code isn't signed in for this workspace."],
  [/gh: .*auth|gh auth login/i, "The GitHub CLI isn't signed in (run gh auth login)."],
  [/command not found|No such file or directory \(os error 2\)/i, "A tool it needs isn't installed."],
  [/timed out/i, "It took too long and was stopped."],
  [/invalid reference|unknown revision|not a valid object name/i, "Git couldn't find a branch or commit it needs."],
  [/database is locked/i, "The app's data was busy; try again."],
  [/error\[E\d+\]|could not compile|build failed/i, "The build failed. Open Builds (⌘⇧B) for the log."],
];

export function shortError(e: unknown): string {
  const raw = String(e instanceof Error ? e.message : e ?? "").replace(/^Error:\s*/, "").trim();
  for (const [re, say] of KNOWN) if (re.test(raw)) return say;
  const first = (raw.split("\n").map((l) => l.trim()).find((l) => l && !/^(usage|warning|hint):/i.test(l)) ?? raw.split("\n")[0] ?? "")
    .replace(/^(fatal|error|Error|panic):\s*/i, "").trim();
  if (!first) return "Something went wrong.";
  const line = first.charAt(0).toUpperCase() + first.slice(1);
  return line.length > 160 ? `${line.slice(0, 157)}…` : /[.!?]$/.test(line) ? line : `${line}.`;
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <span role="alert" data-mr="ErrorLine" style={{ color: "var(--mr-error)" }}>{shortError(error)}</span>;
}
