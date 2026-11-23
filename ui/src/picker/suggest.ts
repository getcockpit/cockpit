import { isBrief, isOpenQuestion, isStalled, type Doc } from "../state/docs";
import type { Pr } from "../state/store";
import type { AppState } from "../state/types";
import { isAbout } from "./autoReview";
import { pickTile } from "./pick";
import { plural, sessionTitle } from "./title";
import { fixReady, needsQueue } from "./queue";

// The suggested-next engine (decision 20): plain rules that propose the next useful move, each with
// its reason, as a one-click action. At most three; dismissed ones stay hidden. PRs to review or
// address are not suggested here (MR-192): the start picker lists them and auto-review takes them.

export type Suggestion = {
  id: string; // stable, so a dismissal sticks
  why: string;
  what: string;
  action: { kind: "open_session"; id: string } | { kind: "open_doc"; id: string } | { kind: "resume"; id: string } | { kind: "build_mine" } | { kind: "usage_review"; repo: string } | { kind: "docs_done"; ids: string[] } | { kind: "tip"; tip: Tip };
  label: string;
  rank: number; // lower first
};

// One of my PRs is worth addressing when a reviewer asked for changes or a thread waits on my reply.
// The intro is three steps (MR-216); the rest arrives later as one tip at a time, once you've run a session.
export type Tip = "plan" | "review" | "address" | "workspaces";
const TIPS: { tip: Tip; what: string; label: string }[] = [
  { tip: "plan", what: "For fuzzy work, pick “Plan it first”: Claude writes a one-page plan you answer and mark up before any code", label: "Plan something" },
  { tip: "review", what: "Review a PR one finding at a time, riskiest first, and publish your notes as one GitHub review", label: "Review a PR" },
  { tip: "address", what: "Fix PR comments: each reviewer thread becomes a choice, and the session makes the fix", label: "Fix PR comments" },
  { tip: "workspaces", what: "One workspace per client: its own Claude sign-in, memory and history. ⌘0 shows all of them", label: "Add a workspace" },
];
export function nextTip(state: AppState, dismissed: Set<string>): Suggestion | null {
  const sessions = Object.values(state.sessions);
  if (!sessions.some((s) => s.transcript.some((i) => i.kind === "result"))) return null; // after your first finished turn
  const used = (t: Tip) => t === "workspaces" ? (state.workspaces?.length ?? 0) > 1 : sessions.some((s) => s.kind === t);
  const t = TIPS.find((x) => !dismissed.has(`tip:${x.tip}`) && !used(x.tip));
  return t ? { id: `tip:${t.tip}`, why: "Tip", what: t.what, action: { kind: "tip", tip: t.tip }, label: t.label, rank: 7 } : null;
}

export const toAddress = (p: Pr) => p.reviewDecision === "CHANGES_REQUESTED" || (p.waiting ?? 0) > 0;
export function addressNote(p: Pr): string {
  const parts = [p.reviewDecision === "CHANGES_REQUESTED" && "changes requested", p.waiting && `${plural(p.waiting, "thread")} waiting on you`, p.isDraft && "draft"];
  return parts.filter(Boolean).join(" · ");
}

// Where one of my PRs stands in this workspace's Address sessions: one still open (live), or how
// many comments from others came after the last one started. Other workspaces don't count.
export type AddressState = { live: { id: string; working: boolean; waiting: boolean } | null; lastAt: number | null; fresh: number };
export function addressState(p: Pr, state: AppState, workspace: string): AddressState {
  const mine = state.order.map((id) => state.sessions[id]).filter((s) => s.workspace === workspace && !s.fromDeleted && s.kind === "address" && isAbout(s.title, p));
  const open = mine.filter((s) => !s.archivedAt && s.status !== "ended" && s.status !== "error").pop();
  const lastAt = mine.reduce<number | null>((a, s) => Math.max(a ?? 0, s.startedAt), null);
  const fresh = lastAt === null ? 0 : (p.feedback ?? []).filter((t) => Date.parse(t) > lastAt).length;
  // Waiting on you the way the Wall's needs-you queue sees it (an ask, a thread to decide), else working.
  const live = open ? { id: open.id, working: open.status === "working" || open.status === "starting", waiting: needsQueue([open], []).length > 0 } : null;
  return { live, lastAt, fresh };
}

// The note on an Address row: a live session first, then what's new since the last one, else what GitHub says.
export function addressRow(p: Pr, a: AddressState): { note: string; hot: boolean; session?: string } {
  if (a.live) return { note: a.live.waiting ? "addressing now · needs you" : a.live.working ? "addressing now" : "address open here", hot: a.live.waiting, session: a.live.id };
  if (a.lastAt !== null) return a.fresh
    ? { note: `${plural(a.fresh, "new comment")} since your last address`, hot: true }
    : { note: "addressed here, nothing new", hot: false };
  return { note: addressNote(p), hot: toAddress(p) };
}

// ISO week ("2026-W42"): the weekly usage review is offered once per week.
export function isoWeek(at: number): string {
  const d = new Date(at);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const jan1 = Date.UTC(t.getUTCFullYear(), 0, 1);
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - jan1) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}
export const USAGE_REVIEW = "/mr-usage-review";

// `appRepo` is set only on the owner's Mac (the checkout the app was built from): the review is about
// your own use, so a shared install never sees it (MR-106).
export function suggest(state: AppState, docs: Doc[], dismissed: Set<string>, appRepo: string | null = null, now = Date.now()): Suggestion[] {
  const out: Suggestion[] = [];
  const sessions = state.order.map((id) => state.sessions[id]);

  for (const d of docs) {
    const open = Object.values(d.blocks).filter(isOpenQuestion);
    // Open questions and prose asks live in the needs-you queue, never here too (F2).
    if (!open.length && d.pending_notes.length + d.pending_changes.length) out.push({ id: `doc-regen:${d.id}:${d.version}`, why: `Your notes on “${d.title}” aren't sent yet`, what: "Regenerate the doc with them", action: { kind: "open_doc", id: d.id }, label: "Open", rank: 2 });
  }
  // Doc lifecycle (decision 38): shipped docs close in one click; stalled ones ask build or drop.
  const shipped = docs.filter((d) => !isBrief(d) && d.shipped_at);
  if (shipped.length) out.push({ id: `docs-done:${shipped.map((d) => d.id).join(",")}`, why: shipped.length === 1 ? `“${shipped[0].title}” shipped` : `${plural(shipped.length, "plan")} shipped`, what: "Mark done to archive", action: { kind: "docs_done", ids: shipped.map((d) => d.id) }, label: "Mark done", rank: 3 });
  for (const d of docs) if (isStalled(d, state.sessions, now)) out.push({ id: `doc-stalled:${d.id}:${d.updated_at}`, why: `“${d.title}” hasn't moved in ${plural(Math.floor((now - (d.updated_at ?? now)) / 86_400_000), "day")}`, what: "Build it or drop it", action: { kind: "open_doc", id: d.id }, label: "Open", rank: 5 });
  for (const s of sessions) {
    const t = pickTile(s);
    if (t.state === "interrupted" && s.sdkSessionId) out.push({ id: `resume:${s.id}`, why: "Stopped when the app closed", what: `Resume “${sessionTitle(s)}”`, action: { kind: "resume", id: s.id }, label: "Resume", rank: 3 });
    if ((t.state === "idle" || t.state === "review" || t.state === "done") && Object.keys(s.files).length && !fixReady(s)) out.push({ id: `diff:${s.id}:${Object.keys(s.files).length}`, why: `${plural(Object.keys(s.files).length, "file")} changed in “${sessionTitle(s)}”`, what: "Review its changes", action: { kind: "open_session", id: s.id }, label: "Review", rank: 4 });
  }
  // Applied fixes only reach the app you're using after a rebuild (J14).
  const applied = sessions.filter((s) => s.fixApplied && s.fixApplied > (state.lastBuildAt ?? 0)).length;
  if (applied) out.push({ id: `rebuild:${applied}`, why: `${plural(applied, "fix")} applied to your app`, what: "Rebuild and relaunch to use it", action: { kind: "build_mine" }, label: "Rebuild & relaunch", rank: 1 });

  if (appRepo) {
    const week = isoWeek(now);
    const ran = sessions.some((s) => s.title.startsWith(USAGE_REVIEW) && isoWeek(s.startedAt) === week);
    if (!ran) out.push({ id: `usage-review:${week}`, why: "Weekly", what: "Which features you used this week, and what to remove", action: { kind: "usage_review", repo: appRepo }, label: "Usage review", rank: 6 });
  }

  const tip = nextTip(state, dismissed);
  if (tip) out.push(tip);

  return out.filter((x) => !dismissed.has(x.id)).sort((a, b) => a.rank - b.rank).slice(0, 3);
}
