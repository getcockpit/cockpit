import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Builds } from "./Builds";

// God-mode mark (evals/marks.jsonl): "I press Build and nothing happens". The Build key was a
// type="button" inside the form with no onClick, so only Enter in the field started a build.
test("the Build key submits the form, so clicking it starts a build", () => {
  const html = renderToStaticMarkup(<Builds defaultWorktree="/Users/u/app-worktrees/mine" onClose={() => {}} />);
  expect(html).toMatch(/<button type="submit" class="mr-key" data-tone="primary"><kbd>↵<\/kbd>Build<\/button>/);
});
