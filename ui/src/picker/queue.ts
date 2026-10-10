import { isOpenQuestion, type Block, type Doc } from "../state/docs";
import type { PendingAsk, SessionState } from "../state/types";
import { flowWaiting, pickTile } from "./pick";

// The one needs-you queue (MR-41, JTBD J3): everything waiting on the user, in one list, oldest
// first. Every count in the app (lamp, workspace badge, section header) reads from this, so they
// can never disagree.

export type QueueItem =
  | { kind: "ask"; key: string; s: SessionState; a: PendingAsk; at: number }
  | { kind: "prose"; key: string; s: SessionState; question: string; options: string[]; at: number }
  | { kind: "doc"; key: string; d: Doc; b: Block; at: number }
  | { kind: "flow"; key: string; s: SessionState; what: string; at: number }
  | { kind: "fix"; key: string; s: SessionState; at: number };

/** A finished god-mode fix whose change hasn't been applied to your app yet (J14). */
export const fixReady = (s: SessionState) =>
  /^God-mode mark/.test(s.title) && !!s.branch?.startsWith("mr/") && !s.fixApplied && (s.status === "idle" || s.status === "ended") && Object.keys(s.files).length > 0;

/** The last question-like paragraph of a finished turn, for showing it on its own. */
export function proseQuestion(text: string): string {
  const paras = text.trim().split(/\n\s*\n|\n(?=[A-Z])/).map((p) => p.trim()).filter(Boolean);
  const q = [...paras].reverse().find((p) => /\?\s*$/.test(p)) ?? paras.at(-1) ?? "";
  // Keep the sentence(s) that end in "?", dropping lead-in sentences.
  const sentences = q.split(/(?<=[.!])\s+(?=[A-Z])/);
  const tail = sentences.filter((x, i) => i === sentences.length - 1 || /\?\s*$/.test(x)).join(" ");
  return tail.slice(0, 280);
}

// "…want me to X, or Y?" / "Should I X?" — the phrase that makes what follows a set of choices.
const LEAD = /\b(?:do you want me to|would you like me to|if you want me to|want me to|should i|shall i|should we|shall we|would you like to)\s+/i;

/** Quick replies a question offers: "open a PR, or keep going?" → ["Open a PR", "Keep going"]. */
export function replyOptions(question: string): string[] {
  const q = question.trim().replace(/\?\s*$/, "");
  const m = q.match(LEAD);
  if (!m || m.index === undefined) return [];
  const body = q.slice(m.index + m[0].length);
  const parts = body.split(/,?\s+or\s+|,\s+/i).map((p) => p.trim().replace(/^(to|instead)\s+/i, "")).filter((p) => p.length > 1 && p.length <= 48);
  const cap = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
  if (parts.length >= 2 && parts.length <= 3) return parts.map(cap);
  return parts.length === 1 ? ["Yes, go ahead", "No"] : [];
}

export function needsQueue(sessions: SessionState[], docs: Doc[]): QueueItem[] {
  const out: QueueItem[] = [];
  for (const s of sessions) {
    if (s.archivedAt) continue;
    for (const a of s.pending) out.push({ kind: "ask", key: `ask:${a.requestId}`, s, a, at: a.at });
    const flow = s.pending.length ? null : flowWaiting(s);
    if (!s.pending.length && fixReady(s)) out.push({ kind: "fix", key: `fix:${s.id}`, s, at: s.lastActivity });
    else if (flow) out.push({ kind: "flow", key: `flow:${s.id}:${s.transcript.length}`, s, what: flow, at: s.lastActivity });
    else if (!s.pending.length && pickTile(s).state === "needs_you") {
      const last = s.transcript.filter((t) => t.kind === "text" || t.kind === "user").at(-1);
      if (last && last.kind === "text") {
        const question = proseQuestion(last.text);
        out.push({ kind: "prose", key: `prose:${last.id}`, s, question, options: replyOptions(question), at: last.at });
      }
    }
  }
  for (const d of docs) {
    const owner = d.session_id ? sessions.find((s) => s.id === d.session_id) : null;
    if (owner?.archivedAt) continue;
    for (const b of Object.values(d.blocks).filter(isOpenQuestion)) out.push({ kind: "doc", key: `doc:${d.id}:${b.id}`, d, b, at: 0 });
  }
  // A plan session asking in prose about its doc's open question is the same ask: keep the doc card
  // (it can be decided in place) and drop the prose duplicate.
  const docSessions = new Set(out.filter((x) => x.kind === "doc").map((x) => (x as { d: Doc }).d.session_id));
  return out.filter((x) => !(x.kind === "prose" && docSessions.has(x.s.id))).sort((a, b) => a.at - b.at);
}
