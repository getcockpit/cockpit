import { expect, test } from "vitest";
import { shortError } from "./ErrorLine";

test("errors read as one plain sentence, never a dump", () => {
  expect(shortError("warning: Not a git repository. Use --no-index…\nusage: git diff --no-index")).toBe("This folder isn't a git repository.");
  expect(shortError(new Error("fatal: invalid reference: main\nhint: x"))).toBe("Git couldn't find a branch or commit it needs.");
  expect(shortError("To get started with GitHub CLI, please run:  gh auth login\nAlternatively…")).toBe("The GitHub CLI isn't signed in (run gh auth login).");
  expect(shortError("unknown session")).toBe("That session isn't running any more. Resume it first.");
  expect(shortError("fatal: something odd happened")).toBe("Something odd happened.");
  expect(shortError("zsh: command not found: bun")).toBe("bun isn't installed (or isn't on the PATH).");
  expect(shortError("gh not available: No such file or directory (os error 2)")).toBe("gh isn't installed (or isn't on the PATH).");
  expect(shortError("git: No such file or directory (os error 2)")).toBe("Something it needs is missing (git): no such file or folder.");
  expect(shortError("No such file or directory (os error 2)")).toBe("Something it needs is missing: no such file or folder.");
  expect(shortError("")).toBe("Something went wrong.");
});
