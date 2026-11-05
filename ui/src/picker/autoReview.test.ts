import { describe, expect, it } from "vitest";
import { cloneWorkspaces, isAbout, lastLocalReview, needsAutoReview, prHere, rankReview, reviewKey, reviewStatus, workspaceFolders } from "./autoReview";
import type { SessionState } from "../state/types";

const pr = { number: 482, title: "Retry payments", url: "https://github.com/acme/shop/pull/482", updatedAt: "", repository: { nameWithOwner: "acme/shop" } };
const info = (o: Partial<{ isDraft: boolean; headSha: string; lastCommitAt: string | null; myLastReviewAt: string | null }> = {}) =>
  ({ isDraft: false, headSha: "abc", lastCommitAt: "2026-10-10T10:00:00Z", myLastReviewAt: null, ...o });
const T = (iso: string) => Date.parse(iso);

describe("auto-review (MR-72)", () => {
  it("reviews a PR you never reviewed", () => {
    expect(needsAutoReview(info(), pr.url, null, new Set())).toBe(true);
  });

  it("never reviews a draft", () => {
    expect(needsAutoReview(info({ isDraft: true }), pr.url, null, new Set())).toBe(false);
  });

  it("skips a PR with no commits since your GitHub review", () => {
    expect(needsAutoReview(info({ myLastReviewAt: "2026-10-10T11:00:00Z" }), pr.url, null, new Set())).toBe(false);
  });

  it("reviews again when commits landed after your last review", () => {
    expect(needsAutoReview(info({ myLastReviewAt: "2026-10-10T09:00:00Z" }), pr.url, null, new Set())).toBe(true);
  });

  it("counts a Review session here as a review, the newer of the two wins", () => {
    expect(needsAutoReview(info(), pr.url, T("2026-10-10T11:00:00Z"), new Set())).toBe(false);
    expect(needsAutoReview(info({ myLastReviewAt: "2026-10-10T09:00:00Z" }), pr.url, T("2026-10-10T11:00:00Z"), new Set())).toBe(false);
    expect(needsAutoReview(info({ myLastReviewAt: "2026-10-10T11:00:00Z" }), pr.url, T("2026-10-10T09:00:00Z"), new Set())).toBe(false);
  });

  it("starts once per head commit", () => {
    expect(needsAutoReview(info(), pr.url, null, new Set([reviewKey(pr.url, "abc")]))).toBe(false);
    expect(needsAutoReview(info({ headSha: "def" }), pr.url, null, new Set([reviewKey(pr.url, "abc")]))).toBe(true);
  });

  it("matches sessions by URL, #n, n or owner/name#n, and only Review sessions", () => {
    for (const t of ["/review https://github.com/acme/shop/pull/482", "/review 482", "/review #482", "/review acme/shop#482"]) expect(isAbout(t, pr)).toBe(true);
    expect(isAbout("/review 4821", pr)).toBe(false);
    const s = (kind: string, title: string, startedAt: number) => ({ kind, title, startedAt }) as SessionState;
    expect(lastLocalReview([s("review", "/review 482", 5), s("review", `/review ${pr.url}`, 9), s("blank", "/review 482", 20), s("review", "/review 1", 30)], pr)).toBe(9);
    expect(lastLocalReview([], pr)).toBeNull();
  });
});

describe("PR suggestions per workspace", () => {
  const s = (id: string, workspace: string, cwd: string, repo: string | null = null, fromDeleted: string | null = null) => ({ id, workspace, cwd, repo, fromDeleted }) as unknown as SessionState;
  const state = (sessions: SessionState[], folders: Record<string, string | null> = {}) => ({
    sessions: Object.fromEntries(sessions.map((x) => [x.id, x])),
    order: sessions.map((x) => x.id),
    workspaces: [{ id: "personal", name: "Personal", configDir: null, folder: folders.personal ?? null }, { id: "work", name: "Work", configDir: null, folder: folders.work ?? null }],
  });

  it("belongs to the workspaces whose sessions ran in the clone, its worktrees or subfolders, newest first", () => {
    const st = state([s("a", "personal", "/c/shop/ui"), s("b", "work", "/c/shop-worktrees/fix-1", "/c/shop"), s("c", "personal", "/c/shopify")]);
    expect(cloneWorkspaces(st, "/c/shop")).toEqual(["work", "personal"]);
    expect(cloneWorkspaces(st, "/c/other")).toEqual([]);
  });

  it("counts a pinned folder, and not sessions from a deleted workspace", () => {
    expect(cloneWorkspaces(state([s("a", "personal", "/c/shop", null, "Old")], { work: "/c/shop" }), "/c/shop")).toEqual(["work"]);
  });

  it("shows a PR only where its repo is worked on, or everywhere when nowhere yet", () => {
    expect(prHere(["work"], "personal")).toBe(false);
    expect(prHere(["work"], "work")).toBe(true);
    expect(prHere([], "personal")).toBe(true);
  });
});

describe("the start picker's review status", () => {
  const s = (id: string, status: string, startedAt: number, workspace = "work", title = `/review ${pr.url}`) => ({ id, kind: "review", workspace, title, status, startedAt }) as unknown as SessionState;
  const at = { ...pr, reviewNote: "not reviewed yet", lastCommitAt: "2026-10-10T10:00:00Z", myLastReviewAt: null };

  it("shows a review running in this workspace, and opens it", () => {
    expect(reviewStatus(at, [s("a", "ended", T("2026-10-09T10:00:00Z")), s("b", "working", T("2026-10-11T10:00:00Z"))], "work")).toEqual({ note: "reviewing now", hot: true, session: "b" });
    expect(reviewStatus(at, [s("b", "needs_you", T("2026-10-11T10:00:00Z"))], "work").note).toBe("reviewing now · needs you");
    expect(reviewStatus(at, [s("b", "idle", T("2026-10-11T10:00:00Z"))], "work")).toEqual({ note: "review open here", hot: true, session: "b" });
  });

  it("only counts this workspace's sessions", () => {
    expect(reviewStatus(at, [s("b", "working", T("2026-10-11T10:00:00Z"), "personal")], "work")).toEqual({ note: "not reviewed yet", hot: true });
  });

  it("says whether commits landed since the last review here", () => {
    expect(reviewStatus(at, [s("a", "ended", T("2026-10-09T10:00:00Z"))], "work")).toEqual({ note: "new changes since your review", hot: true });
    expect(reviewStatus(at, [s("a", "ended", T("2026-10-11T10:00:00Z"))], "work")).toEqual({ note: "reviewed here, nothing new", hot: false });
  });

  it("keeps GitHub's note when your GitHub review is newer, or nothing ran here", () => {
    const gh = { ...at, reviewNote: "asked again, nothing new", myLastReviewAt: "2026-10-12T10:00:00Z" };
    expect(reviewStatus(gh, [s("a", "ended", T("2026-10-11T10:00:00Z"))], "work").note).toBe("asked again, nothing new");
    expect(reviewStatus(at, [s("x", "working", 0, "work", "/review 999")], "work").note).toBe("not reviewed yet");
  });
});

describe("the Review list's order", () => {
  const p = (number: number, o: Partial<{ requested: boolean; needsReview: boolean; isDraft: boolean }> = {}) =>
    ({ number, title: "", url: `https://github.com/acme/shop/pull/${number}`, updatedAt: "", repository: { nameWithOwner: "acme/shop" }, reviewNote: "not reviewed yet", needsReview: true, requested: false, ...o });

  it("asks-for-my-review first, then others that need it, then the rest, drafts last and labelled", () => {
    const rows = rankReview([p(1), p(2, { isDraft: true, requested: true }), p(3, { needsReview: false }), p(4, { requested: true }), p(5, { isDraft: true })], [], "work");
    expect(rows.map((r) => r.pr.number)).toEqual([4, 1, 3, 2, 5]);
    expect(rows[3]).toMatchObject({ note: "draft · not reviewed yet", hot: false });
  });

  it("drops a PR reviewed here with nothing new out of the needs-review tiers", () => {
    const s = { id: "a", kind: "review", workspace: "work", title: "/review https://github.com/acme/shop/pull/4", status: "ended", startedAt: T("2026-10-11T10:00:00Z") } as unknown as SessionState;
    const rows = rankReview([p(4, { requested: true }), p(1), p(3, { needsReview: false })].map((x) => ({ ...x, lastCommitAt: "2026-10-10T10:00:00Z" })), [s], "work");
    expect(rows.map((r) => r.pr.number)).toEqual([1, 4, 3]);
  });

  it("takes the workspace's folders: pinned first, then its sessions', newest first, once each", () => {
    const st = { workspaces: [{ id: "work", folder: "/code/a" }], order: ["1", "2", "3", "4"], sessions: {
      1: { workspace: "work", cwd: "/code/b", repo: null }, 2: { workspace: "home", cwd: "/code/x", repo: null },
      3: { workspace: "work", cwd: "/code/a-worktrees/t", repo: "/code/a" }, 4: { workspace: "work", cwd: "/code/c", repo: null, fromDeleted: "w" } } } as unknown as Parameters<typeof workspaceFolders>[0];
    expect(workspaceFolders(st, "work")).toEqual(["/code/a", "/code/b"]);
  });
});
