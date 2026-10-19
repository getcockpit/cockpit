import { describe, expect, it } from "vitest";
import { cloneWorkspaces, isAbout, lastLocalReview, needsAutoReview, prHere, reviewKey } from "./autoReview";
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
