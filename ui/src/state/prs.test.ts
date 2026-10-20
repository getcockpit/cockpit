import { describe, expect, test } from "vitest";
import { mergeReviewPrs, watchedKey } from "./prs";
import { watchSlug } from "./prRepo";
import type { Pr } from "./store";

const pr = (repo: string, n: number, extra: Partial<Pr> = {}): Pr => ({ number: n, title: `#${n}`, url: `https://github.com/${repo}/pull/${n}`, updatedAt: "2026-10-19T10:00:00Z", repository: { nameWithOwner: repo }, ...extra });

describe("auto-review over watched repos (MR-170)", () => {
  test("requested PRs first, then watched ones, each URL once", () => {
    const requested = [pr("acme/shop", 1), pr("globex/forge", 7)];
    const watched = [pr("globex/forge", 7, { reviewNote: "not reviewed yet" }), pr("globex/forge", 9), pr("globex/forge", 9)];
    const out = mergeReviewPrs(requested, watched, ["globex/forge"]);
    expect(out.map((p) => p.url)).toEqual([
      "https://github.com/acme/shop/pull/1",
      "https://github.com/globex/forge/pull/7",
      "https://github.com/globex/forge/pull/9",
    ]);
    expect(out[1].reviewNote).toBeUndefined(); // the review-requested copy wins
  });

  test("drops watched PRs from a repo no longer watched (case-insensitive), never requested ones", () => {
    const watched = [pr("globex/forge", 9), pr("acme/old", 3), { ...pr("x/y", 4), repository: undefined, url: "https://github.com/Acme/Shop/pull/4" }];
    expect(mergeReviewPrs([pr("acme/old", 1)], watched, ["Globex/Forge", "acme/shop"]).map((p) => p.number)).toEqual([1, 9, 4]);
    expect(mergeReviewPrs([pr("acme/shop", 1)], watched, [])).toHaveLength(1);
  });

  test("cache key changes with the repo list", () => {
    expect(watchedKey(["a/b"])).not.toBe(watchedKey(["a/b", "c/d"]));
  });

  test("watchSlug takes owner/name or a repo URL, like the core's safe_slug", () => {
    expect(watchSlug(" globex/forge ")).toBe("globex/forge");
    expect(watchSlug("https://github.com/globex/forge.git")).toBe("globex/forge");
    expect(watchSlug("github.com/my-org/my.repo_1/")).toBe("my-org/my.repo_1");
    expect(watchSlug("forge")).toBeNull();
    expect(watchSlug("a/b/c")).toBeNull();
    expect(watchSlug("a/b\" OR x")).toBeNull();
    expect(watchSlug("")).toBeNull();
  });
});
