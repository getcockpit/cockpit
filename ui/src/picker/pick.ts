import type { PendingAsk, SessionState } from "../state/types";

// Picker layer 1 (decision 5): plain code maps typed agent state to catalog components.
// No model involved; anything this layer can't classify falls through to layer 2 (MR-20).

export type Risk = "low" | "medium" | "high";

export type DecisionSpec =
  | { component: "CommandCard"; requestId: string; command: string; description: string; risk: Risk; why: string }
  | { component: "DiffCard"; requestId: string; tool: string; path: string; added: number; removed: number; preview: string; risk: Risk; why: string }
  | { component: "QuestionCard"; requestId: string; questions: Extract<PendingAsk, { kind: "question" }>["questions"] }
  | { component: "ToolCard"; requestId: string; tool: string; summary: string; risk: Risk; why: string };

export type TileSpec = {
  state: "needs_you" | "working" | "almost" | "idle" | "done" | "error" | "starting" | "interrupted";
  step: string;
  progress: number | null; // 0..1 from todos, null when unknown
  progressLabel: string;
  doing: string;
};

export type RenderRecord = { component: string; layer: "code"; source: string; ms: number };

const HIGH = [/\brm\s+-[a-z]*r[a-z]*f/i, /\bgit\s+push\b.*--force/, /\bsudo\b/, /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh/, /\bdrop\s+(table|database)\b/i, /\bkubectl\s+(delete|apply)\b/, /\bterraform\s+(apply|destroy)\b/, /\b(prisma|alembic|knex)\b.*\b(migrate|deploy)\b/, /\bmigrate\b.*\b(deploy|up)\b/];
const MEDIUM = [/\bgit\s+(push|reset|rebase|checkout\s+-f|clean)\b/, /\b(npm|bun|pnpm|yarn)\s+(install|add|remove|publish)\b/, /\brm\b/, /\bmv\b/, /\bchmod\b/, />\s*[^&]/, /\bdocker\b/];

export function bashRisk(command: string): { risk: Risk; why: string } {
  const h = HIGH.find((r) => r.test(command));
  if (h) return { risk: "high", why: "Changes shared or remote state, or is hard to undo." };
  const m = MEDIUM.find((r) => r.test(command));
  if (m) return { risk: "medium", why: "Changes files, dependencies or git history in this worktree." };
  return { risk: "low", why: "Reads or runs locally without lasting changes." };
}

const lineCount = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

export function pickDecision(ask: PendingAsk): { spec: DecisionSpec; record: RenderRecord } {
  const t0 = performance.now();
  let spec: DecisionSpec;
  if (ask.kind === "question") {
    spec = { component: "QuestionCard", requestId: ask.requestId, questions: ask.questions };
  } else if (ask.tool === "Bash") {
    const command = String(ask.input.command ?? "");
    spec = { component: "CommandCard", requestId: ask.requestId, command, description: String(ask.input.description ?? ""), ...bashRisk(command) };
  } else if (ask.tool === "Edit" || ask.tool === "Write" || ask.tool === "MultiEdit") {
    const path = String(ask.input.file_path ?? "");
    const added = ask.tool === "Write" ? lineCount(ask.input.content) : ask.tool === "Edit" ? lineCount(ask.input.new_string) : 0;
    const removed = ask.tool === "Edit" ? lineCount(ask.input.old_string) : 0;
    const preview = String(ask.tool === "Write" ? ask.input.content ?? "" : ask.input.new_string ?? "").split("\n").slice(0, 8).join("\n");
    const outside = path.includes("..") || /^\/(etc|usr|bin|System)\//.test(path);
    spec = { component: "DiffCard", requestId: ask.requestId, tool: ask.tool, path, added, removed, preview, risk: outside ? "high" : "medium", why: outside ? "Writes outside the project." : "Edits a file in this worktree." };
  } else {
    const summary = Object.entries(ask.input).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
    const network = /^(WebFetch|WebSearch)$/.test(ask.tool);
    spec = { component: "ToolCard", requestId: ask.requestId, tool: ask.tool, summary, risk: network ? "medium" : "low", why: network ? "Reaches the network." : ask.tool.startsWith("mcp__") ? "Calls an MCP tool." : "Uses a tool." };
  }
  return { spec, record: { component: spec.component, layer: "code", source: ask.requestId, ms: performance.now() - t0 } };
}

export function pickTile(s: SessionState): TileSpec {
  const total = s.todos.length;
  const done = s.todos.filter((t) => t.status === "completed").length;
  const current = s.todos.find((t) => t.status === "in_progress");
  const progress = total ? done / total : null;
  const lastTool = [...s.transcript].reverse().find((t) => t.kind === "tool");
  const lastText = [...s.transcript].reverse().find((t) => t.kind === "text");
  // A finished turn whose last words are a question is waiting on the user, even without a card.
  const lastItem = s.transcript.filter((t) => t.kind === "text" || t.kind === "user").at(-1);
  const askedInProse = s.status === "idle" && lastItem?.kind === "text" && /\?\s*$/.test(lastItem.text.trim());
  const state: TileSpec["state"] =
    s.status === "needs_you" || askedInProse ? "needs_you"
    : s.status === "error" ? "error"
    : s.status === "ended" ? "done"
    : s.status === "starting" ? "starting"
    : s.status === "interrupted" ? "interrupted"
    : s.status === "idle" ? "idle"
    : total && (done >= total - 1 || done / total >= 0.8) ? "almost"
    : "working";
  const ask = s.pending[0];
  const doing = s.status === "interrupted" ? "Stopped when the app closed. Resume continues the same conversation."
    : askedInProse && lastItem?.kind === "text" ? `Asks: ${lastItem.text.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 120)}`
    : ask
    ? ask.kind === "question" ? `Asks: ${ask.questions[0]?.question ?? "a question"}` : `Wants to use ${ask.tool}`
    : current?.activeForm ?? (lastTool && lastTool.kind === "tool" ? `${lastTool.name}${lastTool.input.command ? `: ${String(lastTool.input.command).slice(0, 60)}` : lastTool.input.file_path ? ` ${String(lastTool.input.file_path).split("/").pop()}` : ""}` : lastText && lastText.kind === "text" ? lastText.text.slice(0, 80) : "Starting…");
  return {
    state,
    step: total ? `Step ${Math.min(done + 1, total)} of ${total}` : s.status === "idle" ? "Waiting for you" : "Working",
    progress,
    progressLabel: progress === null ? "" : `${Math.round(progress * 100)}%`,
    doing,
  };
}
