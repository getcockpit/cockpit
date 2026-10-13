import { describe, expect, it } from "vitest";
import { resolveTyped } from "./typedPath";

const home = "/Users/me";

describe("resolveTyped", () => {
  it("leaves filter text alone", () => {
    expect(resolveTyped("app", "~/code", home)).toBeNull();
    expect(resolveTyped(".git", "~/code", home)).toBeNull();
    expect(resolveTyped("~me", "~/code", home)).toBeNull();
  });
  it("takes home and absolute paths", () => {
    expect(resolveTyped("~", "/x", home)).toBe("~");
    expect(resolveTyped(" ~/code/app/ ", "/x", home)).toBe("~/code/app");
    expect(resolveTyped("/opt//a/./b", "/x", home)).toBe("/opt/a/b");
  });
  it("resolves . and .. against the current folder", () => {
    expect(resolveTyped("..", "~/code/app", home)).toBe("~/code");
    expect(resolveTyped("../other", "~/code/app/", home)).toBe("~/code/other");
    expect(resolveTyped("./sub", "/srv/app", home)).toBe("/srv/app/sub");
    expect(resolveTyped(".", "/srv/app", home)).toBe("/srv/app");
    expect(resolveTyped("../../..", "/srv/app", home)).toBe("/");
  });
  it("climbs above home into the absolute form", () => {
    expect(resolveTyped("~/..", "/x", home)).toBe("/Users");
    expect(resolveTyped("../..", "~/code", home)).toBe("/Users");
    expect(resolveTyped("~/a/../b", "/x", home)).toBe("~/b");
  });
});
