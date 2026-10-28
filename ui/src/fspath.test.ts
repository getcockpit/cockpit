import { describe, expect, it } from "vitest";
import { basename, dirname, segments, slashed } from "./fspath";

describe("fspath", () => {
  it("splits posix paths", () => {
    expect(segments("/Users/me/repo/")).toEqual(["Users", "me", "repo"]);
    expect(basename("/Users/me/repo")).toBe("repo");
    expect(basename("/Users/me/repo/")).toBe("repo");
    expect(basename("src/a.ts")).toBe("a.ts");
    expect(basename("a.ts")).toBe("a.ts");
    expect(basename("/")).toBe("");
    expect(basename("")).toBe("");
    expect(dirname("/Users/me/repo")).toBe("/Users/me");
    expect(dirname("/repo")).toBe("/");
    expect(dirname("src/a.ts")).toBe("src");
    expect(dirname("a.ts")).toBe("");
  });
  it("splits Windows paths", () => {
    expect(segments("C:\\Users\\me\\repo")).toEqual(["C:", "Users", "me", "repo"]);
    expect(basename("C:\\Users\\me\\repo")).toBe("repo");
    expect(basename("C:\\Users\\me\\repo\\")).toBe("repo");
    expect(basename("C:/Users/me/repo")).toBe("repo");
    expect(basename("\\\\server\\share\\repo")).toBe("repo");
    expect(dirname("C:\\Users\\me\\repo")).toBe("C:\\Users\\me");
    expect(dirname("C:\\Users\\me\\repo\\")).toBe("C:\\Users\\me");
    expect(dirname("\\\\server\\share\\repo")).toBe("\\\\server\\share");
  });
  it("normalises separators", () => {
    expect(slashed("C:\\code\\app-worktrees\\x")).toBe("C:/code/app-worktrees/x");
    expect(slashed("/a/b")).toBe("/a/b");
  });
});
