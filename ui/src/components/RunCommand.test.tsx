import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunCommand } from "./RunCommand";
import { inline } from "./Markdown";
import { inlineCommand } from "../picker/commands";

// The god-mode packet: a report item whose `git fetch` was a failure report rendered "git fetch▶ Run".
test("a reported failure renders as plain code, without ▶ Run", () => {
  const line = "**Side note**: `git fetch` failed with `Permission denied (publickey)`. I fast-forwarded to the local `origin/main`, which may be stale.";
  const html = renderToStaticMarkup(<RunCommand.Provider value={() => {}}>{inline(line)}</RunCommand.Provider>);
  expect(html).toContain(">git fetch</code>");
  expect(html).not.toContain("▶ Run");
});

// A span the sentence reports on is an outcome, not a suggestion; a run verb before it still wins.
test("a command the text reports on gets no Run button", () => {
  expect(inlineCommand("git fetch", "**Side note**: ", " failed with `Permission denied (publickey)`.")).toBeNull();
  expect(inlineCommand("npm test", "", " passes now.")).toBeNull();
  expect(inlineCommand("git fetch", "Run ", " failed earlier, so retry it")).toBe("git fetch");
  expect(inlineCommand("git fetch", "Next: ", " to update origin.")).toBe("git fetch");
});
