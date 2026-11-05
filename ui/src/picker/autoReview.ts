import type { Pr } from "../state/store";
import type { AppState, SessionState } from "../state/types";
import { slashed } from "../fspath";

// Auto-review (MR-72): a PR waiting for your review gets a /review session by itself, unless it's a
// draft or nothing changed since your last review (on GitHub, or a Review session here).

export type ReviewState = { isDraft: boolean; headSha: string | null; lastCommitAt: string | null; myLastReviewAt: string | null };

/** Whether a session's first prompt (`/review` or `/pr-address <url|#n|n>`) is about this PR. */
export function isAbout(title: string, pr: Pr): boolean {
  const arg = title.trim().replace(/^\/(review|pr-address)\s+/, "").trim();
  if (arg.includes(pr.url)) return true;
  const slug = pr.repository?.nameWithOwner;
  return arg === String(pr.number) || arg === `#${pr.number}` || (!!slug && arg === `${slug}#${pr.number}`);
}

/** When this PR was last reviewed here: the newest Review session about it, or null. */
export function lastLocalReview(sessions: SessionState[], pr: Pr): number | null {
  const at = sessions.filter((s) => s.kind === "review" && isAbout(s.title, pr)).map((s) => s.startedAt);
  return at.length ? Math.max(...at) : null;
}

// A Review session still open: running, or paused between steps (idle waits for your "ok").
const CLOSED = new Set(["ended", "error", "interrupted"]);
const OPEN_NOTE: Record<string, string> = { starting: "reviewing now", working: "reviewing now", needs_you: "reviewing now · needs you", idle: "review open here" };

/** What the start picker says about a PR to review, from this workspace's Review sessions and
 *  GitHub: one reviewing it now (`session`, opened instead of starting another), or new commits
 *  since the last review here or on GitHub. A review here counts even if it never posted. */
export function reviewStatus(pr: Pr, sessions: SessionState[], workspace: string): { note: string; hot: boolean; session?: string } {
  const here = sessions.filter((s) => s.kind === "review" && s.workspace === workspace && isAbout(s.title, pr));
  const live = here.filter((s) => !CLOSED.has(s.status)).sort((a, b) => b.startedAt - a.startedAt)[0];
  if (live) return { note: OPEN_NOTE[live.status] ?? "reviewing now", hot: true, session: live.id };
  const local = here.length ? Math.max(...here.map((s) => s.startedAt)) : null;
  const gh = pr.myLastReviewAt ? Date.parse(pr.myLastReviewAt) : null;
  const commit = pr.lastCommitAt ? Date.parse(pr.lastCommitAt) : null;
  if (local !== null && commit !== null && (gh === null || local > gh)) {
    return commit > local ? { note: "new changes since your review", hot: true } : { note: "reviewed here, nothing new", hot: false };
  }
  return { note: pr.reviewNote ?? "", hot: true };
}

export const reviewKey = (url: string, headSha: string | null) => `${url}@${headSha ?? ""}`;

/** Run a review now? Not a draft, not already started for this head, and never reviewed or new commits since. */
export function needsAutoReview(info: ReviewState, url: string, localAt: number | null, started: Set<string>): boolean {
  if (info.isDraft || started.has(reviewKey(url, info.headSha))) return false;
  const gh = info.myLastReviewAt ? Date.parse(info.myLastReviewAt) : null;
  const last = Math.max(gh ?? -Infinity, localAt ?? -Infinity);
  if (last === -Infinity) return true;
  const commit = info.lastCommitAt ? Date.parse(info.lastCommitAt) : null;
  return commit !== null && commit > last;
}

const inside = (path: string, clone: string) => {
  const p = slashed(path).replace(/\/+$/, ""), c = slashed(clone).replace(/\/+$/, "");
  return p === c || p.startsWith(`${c}/`) || p.startsWith(`${c}-worktrees/`);
};

/** The workspaces that work in this clone, most recent first: their pinned folder or a session's repo/folder sits in it. */
export function cloneWorkspaces(state: Pick<AppState, "sessions" | "order" | "workspaces">, clone: string): string[] {
  const out: string[] = [];
  for (const id of [...state.order].reverse()) {
    const s = state.sessions[id];
    if (s && !s.fromDeleted && !out.includes(s.workspace) && [s.repo, s.cwd].some((p) => p && inside(p, clone))) out.push(s.workspace);
  }
  for (const w of state.workspaces) if (w.folder && inside(w.folder, clone) && !out.includes(w.id)) out.push(w.id);
  return out;
}

/** Whether a PR's suggestion belongs in this workspace: its clone's workspaces, or every one when none works in it yet. */
export const prHere = (owners: string[], workspace: string) => !owners.length || owners.includes(workspace);
