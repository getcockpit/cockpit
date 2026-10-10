import { describe, expect, it } from "vitest";
import { isAbout, lastLocalReview, needsAutoReview, reviewKey } from "./autoReview";
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
