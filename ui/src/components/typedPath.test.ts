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
  it("takes Windows drive and UNC paths", () => {
    expect(resolveTyped("C:\\Users\\me\\code", "/x", home)).toBe("C:\\Users\\me\\code");
    expect(resolveTyped("C:/Users//me/./code/", "/x", home)).toBe("C:\\Users\\me\\code");
    expect(resolveTyped("d:\\a\\..\\..\\b", "/x", home)).toBe("d:\\b");
    expect(resolveTyped("C:\\", "/x", home)).toBe("C:\\");
    expect(resolveTyped("\\\\server\\share\\repo", "/x", home)).toBe("\\\\server\\share\\repo");
    expect(resolveTyped("\\\\server\\share\\..\\..", "/x", home)).toBe("\\\\server\\share");
    expect(resolveTyped("C:", "/x", home)).toBeNull();
    expect(resolveTyped("C:code", "/x", home)).toBeNull();
  });
  it("resolves . and .. against a Windows folder", () => {
    expect(resolveTyped("..", "C:\\code\\app", home)).toBe("C:\\code");
    expect(resolveTyped(".\\sub", "C:\\code\\app\\", home)).toBe("C:\\code\\app\\sub");
    expect(resolveTyped("../../..", "C:\\code\\app", home)).toBe("C:\\");
    expect(resolveTyped("../other", "\\\\srv\\share\\app", home)).toBe("\\\\srv\\share\\other");
  });
  it("climbs above a Windows home into its absolute form", () => {
    expect(resolveTyped("~/..", "/x", "C:\\Users\\me")).toBe("C:\\Users");
    expect(resolveTyped("~\\code", "/x", "C:\\Users\\me")).toBe("~/code");
  });
});
