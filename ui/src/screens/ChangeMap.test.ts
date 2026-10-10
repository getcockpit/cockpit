import { describe, expect, it } from "vitest";
import { changesError } from "./ChangeMap";

// God-mode mark: Focus aside showed git's full `diff --no-index` usage page under "Changes:"
// because the "not a git" check was case-sensitive and git writes "Not a git repository".
const packet = `warning: Not a git repository. Use --no-index to compare two paths outside a working tree
usage: git diff --no-index [<options>] <path> <path>

Diff output format options
    -p, --patch           generate patch
    -s, --no-patch        suppress diff output
    --numstat             machine friendly --stat`;

describe("changesError", () => {
  it("collapses git's not-a-repo usage dump to one short line", () => {
    expect(changesError(packet)).toBe("not a git repository");
  });
  it("still matches the lowercase fatal form", () => {
    expect(changesError("fatal: not a git repository (or any of the parent directories): .git")).toBe("not a git repository");
  });
  it("keeps only the first line of other multi-line errors", () => {
    expect(changesError("fatal: something broke\nusage: git status [<options>]\n    -v")).toBe("fatal: something broke");
  });
});
