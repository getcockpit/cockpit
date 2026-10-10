import { expect, test } from "vitest";
import { parseReport } from "../picker/report";
import { asksUser, replyOptions } from "../picker/queue";

// The real reply from the user's shop session (2026-10-10) that rendered as a wall of text.
const shop = `**First decision to make: where does prod run?** The repo has two half-built hosting setups: GCP App Engine and Fly.io + Neon + Cloudflare.

## Where things stand
- **Done:** auth (Auth0 JWT plus mobile login), switch to Gemini, rate limiting.
- **Not started:** everything in the go-live checklist.

## Do now: code fixes, about half a day in total
1. **Broken navigation:** \`mobile/app/WeekReviewScreen.tsx:284\` goes to a \`Cook\` tab that no longer exists. About 15 min.
2. **Stale env var:** \`api/app.yaml:39\` still says \`OPENAI_USE_MOCK\`. About 5 min.
3. **No prod database:** only needed if you stay on GCP. About 1–2 h.

## Manual steps only you can do
1. Create the prod Auth0 tenant.
2. Sign up for Apple Developer ($99) and Google Play ($25).

Next: tell me "GCP" or "Fly". I'll update the checklist to match (about 30 min).`;

test("the shop reply becomes a decision, sections with state, and quick replies", () => {
  const r = parseReport(shop)!;
  expect(r.decision).toBe("First decision to make: where does prod run?");
  expect(r.sections.map((s) => [s.heading, s.tone, s.items.length])).toEqual([
    ["Where things stand", "done", 2],
    ["Do now: code fixes, about half a day in total", "todo", 3],
    ["Manual steps only you can do", "you", 2],
  ]);
  expect(r.sections[1].items[0]).toMatchObject({ title: "Broken navigation", time: "15 min" });
  expect(r.sections[1].items[2].time).toBe("1–2 h");
  expect(r.next).toContain('tell me "GCP" or "Fly"');
  expect(replyOptions(r.next!)).toEqual(["GCP", "Fly"]);
  expect(asksUser(shop)).toBe(true);
});

test("ordinary replies stay plain Markdown", () => {
  expect(parseReport("Done. I fixed the typo in README.md.")).toBeNull();
  expect(parseReport("## Note\nJust one line.")).toBeNull();
});
