import type { ViewBlock } from "./types";

// The PR report (pr_report.rs) as the UI sees it, and how it's shown and shared: catalog blocks
// for the screen, Markdown for the clipboard. Names and the repo stay out unless turned on.

export type Rates = { prs: number; merged: number; judged: number; approved_pct: number | null; changes_requested_pct: number | null; fixed_again_pct: number | null };
export type PrReport = {
  repo: string;
  weeks: number;
  since: number;
  until: number;
  volume: { opened: number[]; merged: number[]; opened_total: number; merged_total: number };
  size: { median_lines: number | null; median_files: number | null; over_1000_pct: number | null };
  rates: Rates;
  by_band: { band: string; rates: Rates }[];
  fixed_again: { pr: number; pr_url: string; fix: number; fix_url: string }[];
  review_load: { reviews: number; top_share_pct: number | null; median_first_review_h: number | null; reviewers: { login: string; reviews: number }[] };
  authors: { login: string; prs: number }[];
  agent: { share_pct: number | null; agent: Rates; other: Rates };
  fetched: number;
  took_ms: number;
};

export type ShareOpts = { names: boolean; repo: boolean };

export const pctText = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Number.isInteger(v) ? v : v.toFixed(1)}%`);
const num = (v: number | null | undefined) => (v === null || v === undefined ? "–" : String(Math.round(v)));
const hours = (h: number | null) => (h === null ? "–" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${(h / 24).toFixed(1)} days`);

/** "Reviewer A", "Reviewer B"… in order of how much each reviewed, unless names are on. */
export function reviewerName(r: PrReport, login: string, names: boolean): string {
  if (names) return `@${login}`;
  const i = r.review_load.reviewers.findIndex((x) => x.login === login);
  if (i < 0) return "someone";
  let label = "", n = i;
  do { label = String.fromCharCode(65 + (n % 26)) + label; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `Reviewer ${label}`;
}

export function reportTitle(r: PrReport, o: ShareOpts): string {
  return `${o.repo ? r.repo : "Our repo"}: PRs over the last ${r.weeks} weeks`;
}

function perWeek(r: PrReport) {
  return r.weeks ? r.volume.opened_total / r.weeks : 0;
}

/** The screen: catalog blocks (stats, compare, takeaway), the same every time for the same data. */
export function reportBlocks(r: PrReport, o: ShareOpts): ViewBlock[] {
  const top = r.review_load.reviewers[0];
  const blocks: ViewBlock[] = [
    { type: "stats", items: [
      { value: perWeek(r).toFixed(perWeek(r) < 10 ? 1 : 0), label: "PRs a week", detail: `${r.volume.opened_total} opened, ${r.volume.merged_total} merged` },
      { value: pctText(r.rates.approved_pct), label: "approved before merge", detail: `of ${r.rates.merged} merged` },
      { value: pctText(r.rates.changes_requested_pct), label: "got changes requested", detail: `of ${r.rates.prs} PRs` },
      { value: pctText(r.rates.fixed_again_pct), label: "fixed again within 7 days", detail: `of ${r.rates.judged} merged a week or more ago` },
    ] },
    { type: "stats", items: [
      { value: num(r.size.median_lines), label: "lines, median PR", detail: `${num(r.size.median_files)} files` },
      { value: pctText(r.size.over_1000_pct), label: "over 1,000 lines" },
      { value: pctText(r.review_load.top_share_pct), label: "of reviews by one person", detail: top ? `${reviewerName(r, top.login, o.names)}, ${top.reviews} of ${r.review_load.reviews}` : "no reviews" },
      { value: hours(r.review_load.median_first_review_h), label: "to first review", detail: "median" },
    ] },
    { type: "compare", criteria: ["PRs", "Approved", "Changes requested", "Fixed again in 7 days"], rows: r.by_band.map((b) => ({
      option: b.band, values: [String(b.rates.prs), pctText(b.rates.approved_pct), pctText(b.rates.changes_requested_pct), pctText(b.rates.fixed_again_pct)],
    })) },
  ];
  if (r.agent.agent.prs > 0) blocks.push({ type: "compare", criteria: ["PRs", "Approved", "Changes requested", "Fixed again in 7 days"], rows: [
    { option: `Written with Claude Code (${pctText(r.agent.share_pct)})`, values: [String(r.agent.agent.prs), pctText(r.agent.agent.approved_pct), pctText(r.agent.agent.changes_requested_pct), pctText(r.agent.agent.fixed_again_pct)] },
    { option: "Everything else", values: [String(r.agent.other.prs), pctText(r.agent.other.approved_pct), pctText(r.agent.other.changes_requested_pct), pctText(r.agent.other.fixed_again_pct)] },
  ] });
  blocks.push({ type: "takeaway", heading: "How to read it", status: "info", items: [
    { title: "Fixed again within 7 days is a loose signal", detail: "A merged PR followed within a week by a merged fix or revert PR touching the same source files (tests, docs and lockfiles don't count). It includes normal iteration." },
    { title: "Approved before merge", detail: "An approving review by someone other than the author, submitted before the merge." },
    { title: "Written with Claude Code", detail: "The PR description mentions Claude Code (its usual footer or co-author line)." },
  ] });
  return blocks;
}

/** Markdown for the clipboard: what a lead would paste into Slack or a doc. */
export function reportMarkdown(r: PrReport, o: ShareOpts): string {
  const top = r.review_load.reviewers[0];
  const lines = [
    `**${reportTitle(r, o)}**`,
    "",
    `- **${perWeek(r).toFixed(1)} PRs a week** (${r.volume.opened_total} opened, ${r.volume.merged_total} merged)`,
    `- **${pctText(r.rates.approved_pct)}** approved before merge; **${pctText(r.rates.changes_requested_pct)}** ever got changes requested`,
    `- **${pctText(r.rates.fixed_again_pct)}** needed a fix to the same files within 7 days`,
    `- Median PR: ${num(r.size.median_lines)} lines, ${num(r.size.median_files)} files; ${pctText(r.size.over_1000_pct)} over 1,000 lines`,
    `- ${pctText(r.review_load.top_share_pct)} of reviews by one person${top ? ` (${reviewerName(r, top.login, o.names)})` : ""}; first review after ${hours(r.review_load.median_first_review_h)} (median)`,
    "",
    "| Size | PRs | Approved | Changes requested | Fixed again in 7 days |",
    "|---|---|---|---|---|",
    ...r.by_band.map((b) => `| ${b.band} | ${b.rates.prs} | ${pctText(b.rates.approved_pct)} | ${pctText(b.rates.changes_requested_pct)} | ${pctText(b.rates.fixed_again_pct)} |`),
  ];
  if (r.agent.agent.prs > 0) lines.push(
    `| Claude Code (${pctText(r.agent.share_pct)}) | ${r.agent.agent.prs} | ${pctText(r.agent.agent.approved_pct)} | ${pctText(r.agent.agent.changes_requested_pct)} | ${pctText(r.agent.agent.fixed_again_pct)} |`,
  );
  lines.push("", "_Fixed again: a merged fix or revert PR touching the same source files within a week. A loose signal; it includes normal iteration._");
  return lines.join("\n");
}
