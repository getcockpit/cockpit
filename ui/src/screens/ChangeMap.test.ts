import { expect, test } from "vitest";
import { changesError } from "./ChangeMap";

// God-mode mark: the focus view's Changes tile dumped git's whole `git diff` usage text
// when the session's folder wasn't a git repo (git says "Not a git repository", capital N).
test("a non-git folder shows one short line, not git's usage dump", () => {
  const raw = `warning: Not a git repository. Use --no-index to compare two paths outside a working tree
usage: git diff --no-index [<options>] <path> <path>

Diff output format options
    -p, --patch           generate patch
    -s, --no-patch        suppress diff output`;
  expect(changesError(raw)).toBe("not a git repository");
  expect(changesError("fatal: not a git repository (or any of the parent directories): .git")).toBe("not a git repository");
});

test("other git errors show only their first line", () => {
  expect(changesError("fatal: bad revision 'HEAD'\nusage: git diff ...\n  -p")).toBe("fatal: bad revision 'HEAD'");
});

// God-mode mark: a session whose worktree was deleted showed git's raw "cannot change to '<path>'" error.
test("a deleted session folder says the worktree is gone, not git's chdir error", () => {
  const raw = "fatal: cannot change to '/Users/me/code/app-worktrees/do-detailed-scan-check-how-s0qn': No such file or directory";
  expect(changesError(raw)).toBe("this session's folder no longer exists (its worktree was removed); send a message to restore it from its branch");
});
