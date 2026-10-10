import { expect, test } from "vitest";
import { shortError } from "./ErrorLine";

test("errors read as one plain sentence, never a dump", () => {
  expect(shortError("warning: Not a git repository. Use --no-index…\nusage: git diff --no-index")).toBe("This folder isn't a git repository.");
  expect(shortError(new Error("fatal: invalid reference: main\nhint: x"))).toBe("Git couldn't find a branch or commit it needs.");
  expect(shortError("To get started with GitHub CLI, please run:  gh auth login\nAlternatively…")).toBe("The GitHub CLI isn't signed in (run gh auth login).");
  expect(shortError("unknown session")).toBe("That session isn't running any more. Resume it first.");
  expect(shortError("fatal: something odd happened")).toBe("Something odd happened.");
  expect(shortError("")).toBe("Something went wrong.");
});
