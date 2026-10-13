import { expect, test } from "vitest";
import { parseReport } from "../picker/report";
import { asksUser, replyOptions } from "../picker/queue";

// A report-shaped reply (shortened from demo/fixtures/report-reply.md) that would otherwise render as a wall of text.
const REPORT = `**First decision to make: where does the shop run in production?** The repo has two half-finished hosting setups: Render and Fly.io + Supabase.

## Where things stand
- **Done:** sign-in (email magic links plus Google), product catalogue, Stripe checkout.
- **Not started:** everything in the launch checklist.

## Do now: code fixes, about half a day in total
1. **Broken link:** \`web/src/pages/OrderDone.tsx:42\` goes to an \`/account/wishlist\` page that no longer exists. About 15 min.
2. **Stale env var:** \`api/render.yaml:18\` still says \`PAYPAL_SANDBOX\`. About 5 min.
3. **No prod database:** only needed if you stay on Render. About 1–2 h.

## Manual steps only you can do
1. Switch the Stripe account to live mode.
2. Register the business with the payment provider for payouts.

Next: tell me "Render" or "Fly". I'll update the checklist to match (about 30 min).`;

test("a report-shaped reply becomes a decision, sections with state, and quick replies", () => {
  const r = parseReport(REPORT)!;
  expect(r.decision).toBe("First decision to make: where does the shop run in production?");
  expect(r.sections.map((s) => [s.heading, s.tone, s.items.length])).toEqual([
    ["Where things stand", "done", 2],
    ["Do now: code fixes, about half a day in total", "todo", 3],
    ["Manual steps only you can do", "you", 2],
  ]);
  expect(r.sections[1].items[0]).toMatchObject({ title: "Broken link", time: "15 min" });
  expect(r.sections[1].items[2].time).toBe("1–2 h");
  expect(r.next).toContain('tell me "Render" or "Fly"');
  expect(replyOptions(r.next!)).toEqual(["Render", "Fly"]);
  expect(asksUser(REPORT)).toBe(true);
});

test("ordinary replies stay plain Markdown", () => {
  expect(parseReport("Done. I fixed the typo in README.md.")).toBeNull();
  expect(parseReport("## Note\nJust one line.")).toBeNull();
});
