import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingUpdates } from "./UpdateBanner";

// God-mode mark (evals/marks.jsonl): "this should have a button that fixes it". Started without
// dev.sh, the banner listed 2 app updates on main but only said to restart with ./scripts/dev.sh.
test("pending updates without dev.sh offer a button that builds and relaunches", () => {
  const status = { mode: "manual" as const, pending: [
    { sha: "f0c3da8", subject: "MR-98: Claude suggests planning in a working doc when a task needs it" },
    { sha: "08fcc58", subject: "Fix: notification banners show while Cockpit is frontmost" },
  ] };
  const html = renderToStaticMarkup(<PendingUpdates status={status} onUpdate={() => {}} onBuild={() => {}} />);
  expect(html).toContain("2 app updates");
  expect(html).toMatch(/<button[^>]*data-tone="primary"[^>]*>Build and relaunch<\/button>/);
  expect(html).not.toContain("./scripts/dev.sh");
});
