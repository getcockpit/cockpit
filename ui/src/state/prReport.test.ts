import { describe, expect, it } from "vitest";
import { reportBlocks, reportMarkdown, reviewerName, type PrReport } from "./prReport";

const rates = (prs: number, a: number | null, c: number | null, f: number | null) => ({ prs, merged: prs, judged: prs, approved_pct: a, changes_requested_pct: c, fixed_again_pct: f });
const report: PrReport = {
  repo: "acme/payments", weeks: 8, since: 0, until: 0,
  volume: { opened: [30, 28, 29, 27, 30, 28, 27, 28], merged: [25, 26, 27, 25, 28, 27, 26, 27], opened_total: 227, merged_total: 211 },
  size: { median_lines: 412, median_files: 7, over_1000_pct: 18.5 },
  rates: rates(227, 96, 3.5, 46),
  by_band: [{ band: "under 200 lines", rates: rates(80, 97, 1, 30) }, { band: "200–999 lines", rates: rates(105, 96, 4, 48) }, { band: "1,000+ lines", rates: rates(42, 93, 7, 65) }],
  fixed_again: [{ pr: 1, pr_url: "u1", fix: 2, fix_url: "u2" }],
  review_load: { reviews: 300, top_share_pct: 61, median_first_review_h: 2.5, reviewers: [{ login: "dana", reviews: 183 }, { login: "eli", reviews: 117 }] },
  authors: [{ login: "frank", prs: 100 }],
  agent: { share_pct: 70, agent: rates(159, 96, 3, 50), other: rates(68, 95, 5, 37) },
  fetched: 227, took_ms: 9000,
};

describe("PR report", () => {
  it("names reviewers by letter unless names are on", () => {
    expect(reviewerName(report, "dana", false)).toBe("Reviewer A");
    expect(reviewerName(report, "eli", false)).toBe("Reviewer B");
    expect(reviewerName(report, "dana", true)).toBe("@dana");
  });

  it("keeps names and the repo out of the shared Markdown by default", () => {
    const md = reportMarkdown(report, { names: false, repo: false });
    for (const secret of ["acme", "payments", "dana", "eli", "frank"]) expect(md).not.toContain(secret);
    expect(md).toContain("Reviewer A");
    expect(md).toContain("**46%** needed a fix to the same files within 7 days");
    expect(md).toContain("| 1,000+ lines | 42 | 93% | 7% | 65% |");
  });

  it("puts them in when turned on", () => {
    const md = reportMarkdown(report, { names: true, repo: true });
    expect(md).toContain("acme/payments");
    expect(md).toContain("@dana");
  });

  it("builds the screen from catalog blocks, with no names in them by default", () => {
    const blocks = reportBlocks(report, { names: false, repo: false });
    expect(blocks.map((b) => b.type)).toEqual(["stats", "stats", "compare", "compare", "takeaway"]);
    expect(JSON.stringify(blocks)).not.toMatch(/dana|eli|frank|acme/);
  });

  it("shows a dash, not 0%, when there's nothing to measure", () => {
    const empty = { ...report, rates: rates(0, null, null, null), agent: { share_pct: null, agent: rates(0, null, null, null), other: rates(0, null, null, null) } };
    const blocks = reportBlocks(empty, { names: false, repo: false });
    expect(JSON.stringify(blocks[0])).toContain("\"value\":\"–\"");
    expect(blocks.filter((b) => b.type === "compare")).toHaveLength(1);
  });
});
