import { asksUser, proseQuestion } from "./queue";
import type { PendingAsk, SessionState } from "../state/types";
import riskRules from "./risk-rules.json";
import { basename } from "../fspath";

// Picker layer 1 (decision 5): plain code maps typed agent state to catalog components.
// No model involved; anything this layer can't classify falls through to layer 2 (MR-20).

export type Risk = "low" | "medium" | "high";

export type DecisionSpec =
  | { component: "CommandCard"; requestId: string; command: string; description: string; risk: Risk; why: string }
  | { component: "DiffCard"; requestId: string; tool: string; path: string; added: number; removed: number; preview: string; risk: Risk; why: string }
  | { component: "QuestionCard"; requestId: string; questions: Extract<PendingAsk, { kind: "question" }>["questions"] }
  | { component: "ToolCard"; requestId: string; tool: string; summary: string; risk: Risk; why: string };

export type TileSpec = {
  state: "needs_you" | "working" | "almost" | "idle" | "review" | "done" | "error" | "starting" | "interrupted";
  step: string;
  progress: number | null; // 0..1 from todos, null when unknown
  progressLabel: string;
  doing: string;
  planOpen?: boolean; // the turn ended with plan steps still open and nothing asked of you (MR-121)
};

export type RenderRecord = { component: string; layer: "code"; source: string; ms: number };

// Shared with the core, which keeps asking about these under Never ask (I109).
const HIGH = riskRules.high.map((r) => new RegExp(r.source, r.flags));
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

/** The prose item layer 1 can't place: a finished turn's last words, no "?", not yet classified. */
export function needsLayer2(s: SessionState): { id: string; text: string } | null {
  if (s.status !== "idle") return null;
  const last = s.transcript.filter((t) => t.kind === "text" || t.kind === "user").at(-1);
  if (!last || last.kind !== "text" || s.kinds[last.id] || /\?\s*$/.test(last.text.trim())) return null;
  return { id: last.id, text: last.text };
}

/** A Review or Address flow paused on the user's turn (J8): what it's waiting for, or null. */
export function flowWaiting(s: SessionState): string | null {
  if (s.status !== "idle") return null;
  const r = s.review;
  if (r?.published) return null;
  if (r?.publish) return `Review ready to publish · ${r.publish.comments?.length ?? 0} comments`;
  if (r && r.current !== null) {
    const sn = r.snippets[r.current];
    const n = sn?.findings?.length ?? 0;
    return `Snippet ${r.current} of ${sn?.total ?? r.overview?.total_snippets ?? "?"} · ${n ? `${n} finding${n === 1 ? "" : "s"} to note or skip` : "nothing flagged"}`;
  }
  // Overview shown, walkthrough not started: the review waits on you to start it (MR-58 walk).
  if (r?.overview && r.current === null) return `Overview ready · ${r.overview.total_snippets ? `${r.overview.total_snippets} snippet${r.overview.total_snippets === 1 ? "" : "s"} to walk` : "start the walkthrough"}`;
  const a = s.address;
  if (a?.done) return `All threads handled${a.done.next?.[0] ? ` · next: ${a.done.next[0].label}` : ""}`;
  // Every thread is drawn up front (MR-126): the user owes a choice on each drawn, undecided one.
  const undecided = a ? Object.values(a.threads).filter((t) => (t.options ?? []).length && !a.chosen[t.id]).length : 0;
  if (undecided) return `${undecided} thread${undecided === 1 ? "" : "s"} · pick how to address ${undecided === 1 ? "it" : "them"}`;
  return null;
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
  // Layer 1 is the trailing "?"; layer 2 (Clef) catches questions, plans and blockers phrased without one.
  const kind = lastItem ? s.kinds[lastItem.id] : undefined;
  const modelSaysWaiting = !!kind && kind.layer === "model" && kind.p >= 0.6 && ["question", "plan", "blocked"].includes(kind.label);
  const askedInProse = s.status === "idle" && lastItem?.kind === "text" && (asksUser(lastItem.text) || modelSaysWaiting);
  const flowStep = flowWaiting(s);
  // Claude Code refused the turn because its login ran out (MR-153): only you can sign it back in.
  const signedOut = !!s.signedOut && (s.status === "idle" || s.status === "ended");
  const running = s.status === "idle" && s.backgroundTasks.length > 0 && !askedInProse && !flowStep ? s.backgroundTasks : null;
  const state: TileSpec["state"] =
    s.status === "needs_you" || askedInProse || flowStep || signedOut ? "needs_you"
    : s.status === "error" ? "error"
    : s.status === "ended" ? "done"
    : s.status === "starting" ? "starting"
    : s.status === "interrupted" ? "interrupted"
    // A finished turn whose plan is all ticked off is work waiting for your review (F10): not "waiting",
    // and not "done" either, which is kept for a session that has ended.
    // Scripts or agents still running after the turn: the session is busy, not waiting on you.
    : running ? "working"
    : s.status === "idle" && total > 0 && done === total ? "review"
    : s.status === "idle" ? "idle"
    : total && (done >= total - 1 || done / total >= 0.8) ? "almost"
    : "working";
  // Claude said it was finished but never ticked the last steps off: say so instead of a stuck 80%.
  const planOpen = state === "idle" && total > 0 && done < total;
  const ask = s.pending[0];
  const doing = s.status === "interrupted" ? "Stopped when the app closed. Resume continues the same conversation."
    : signedOut ? "Claude Code's sign-in expired. Sign in to send your message again."
    : flowStep ? flowStep
    : askedInProse && lastItem?.kind === "text" ? `Asks: ${proseQuestion(lastItem.text).slice(0, 120)}`
    : running ? `Running: ${running[0].description || "a background task"}${running.length > 1 ? ` (+${running.length - 1} more)` : ""}`
    : ask
    ? ask.kind === "question" ? `Asks: ${ask.questions[0]?.question ?? "a question"}` : `Wants to use ${ask.tool}`
    : current?.activeForm ?? (lastTool && lastTool.kind === "tool" ? `${lastTool.name}${lastTool.input.command ? `: ${String(lastTool.input.command).slice(0, 60)}` : lastTool.input.file_path ? ` ${basename(String(lastTool.input.file_path))}` : ""}` : lastText && lastText.kind === "text" ? lastText.text.slice(0, 80) : "Starting…");
  return {
    state,
    step: running ? "Running in background" : state === "review" ? `All ${total} steps done` : planOpen ? `Plan left open · ${done} of ${total}` : total ? `Step ${Math.min(done + 1, total)} of ${total}` : s.status === "idle" ? "Your turn" : "Working",
    progress,
    progressLabel: progress === null ? "" : `${Math.round(progress * 100)}%`,
    doing,
    planOpen,
  };
}
