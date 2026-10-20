import { describe, expect, it } from "vitest";
import { droppedMentions, insertDropped, insertMention, matchDir, matchPaths, outsideQuery, typedMention } from "./mention";

const PATHS = ["docs/", "src-tauri/", "src-tauri/src/", "ui/", "ui/src/", "ui/src/screens/", "README.md", "src-tauri/src/mentions.rs", "ui/src/screens/Focus.tsx", "ui/src/screens/Wall.tsx"];

describe("typedMention", () => {
  it("finds the @ before the caret", () => {
    expect(typedMention("look at @ui/sc", 14)).toEqual({ start: 8, query: "ui/sc" });
    expect(typedMention("@", 1)).toEqual({ start: 0, query: "" });
  });
  it("ignores emails, finished mentions and text after the caret", () => {
    expect(typedMention("mail me@x.com", 13)).toBeNull();
    expect(typedMention("@ui/ done", 9)).toBeNull();
    expect(typedMention("@ui and more", 3)).toEqual({ start: 0, query: "ui" });
  });
});

describe("matchPaths", () => {
  it("lists the top of the folder, folders first, when nothing is typed", () => {
    expect(matchPaths(PATHS, "")).toEqual(["docs/", "src-tauri/", "ui/", "README.md"]);
  });
  it("ranks a name match over a path that merely contains it", () => {
    expect(matchPaths(PATHS, "screens")[0]).toBe("ui/src/screens/");
    expect(matchPaths(PATHS, "focus")).toEqual(["ui/src/screens/Focus.tsx"]);
  });
  it("matches letters in order", () => {
    expect(matchPaths(PATHS, "fcs")).toContain("ui/src/screens/Focus.tsx");
    expect(matchPaths(PATHS, "zzz")).toEqual([]);
  });
});

describe("insertMention", () => {
  it("swaps the query for the path and puts the caret after it", () => {
    expect(insertMention("look at @ui/sc please", { start: 8, query: "ui/sc" }, "ui/src/screens/")).toEqual({ text: "look at @ui/src/screens/ please", caret: 25 });
    expect(insertMention("@", { start: 0, query: "" }, "docs/")).toEqual({ text: "@docs/ ", caret: 7 });
  });
});

describe("dropped files", () => {
  it("mentions each path, quoting ones with spaces", () => {
    expect(droppedMentions(["/a/b.ts", "/x y/shot.png"])).toBe('@/a/b.ts @"/x y/shot.png"');
  });
  it("puts them at the caret with a space either side", () => {
    expect(insertDropped("look at", 7, 7, ["/a.png"])).toEqual({ text: "look at @/a.png ", caret: 16 });
    expect(insertDropped("look at  please", 8, 8, ["/a.png"])).toEqual({ text: "look at @/a.png please", caret: 15 });
    expect(insertDropped("", 0, 0, ["/a.png"])).toEqual({ text: "@/a.png ", caret: 8 });
  });
  it("replaces a selection", () => {
    expect(insertDropped("see THIS now", 4, 8, ["/f"])).toEqual({ text: "see @/f now", caret: 7 });
  });
});

describe("paths outside the session folder", () => {
  it("splits ~, .. and / queries into the folder and the name typed in it", () => {
    expect(outsideQuery("~")).toEqual({ dir: "~/", name: "" });
    expect(outsideQuery("..")).toEqual({ dir: "../", name: "" });
    expect(outsideQuery("~/Doc")).toEqual({ dir: "~/", name: "Doc" });
    expect(outsideQuery("../../app/sr")).toEqual({ dir: "../../app/", name: "sr" });
    expect(outsideQuery("/tmp/x")).toEqual({ dir: "/tmp/", name: "x" });
    expect(outsideQuery("src/ui")).toBeNull();
    expect(outsideQuery(".gitignore")).toBeNull();
  });
  it("matches the folder's entries by name and hides dotfiles until a . is typed", () => {
    const ls = ["~/.zshrc", "~/Desktop/", "~/Documents/", "~/notes.md"];
    expect(matchDir(ls, { dir: "~/", name: "" })).toEqual(["~/Desktop/", "~/Documents/", "~/notes.md"]);
    expect(matchDir(ls, { dir: "~/", name: "doc" })).toEqual(["~/Documents/"]);
    expect(matchDir(ls, { dir: "~/", name: ".z" })).toEqual(["~/.zshrc"]);
  });
});

describe("paths with spaces", () => {
  it("reads an open quote as one query, spaces and all", () => {
    expect(typedMention('see @"~/Library/Application Su', 30)).toEqual({ start: 4, query: "~/Library/Application Su", quoted: true });
    expect(typedMention('see @"/a b/c" and', 17)).toBeNull();
  });
  it("quotes a picked path with spaces, and replaces an open quote", () => {
    expect(insertMention("@~/Lib", { start: 0, query: "~/Lib" }, "~/Library/Application Support/")).toEqual({ text: '@"~/Library/Application Support/" ', caret: 34 });
    expect(insertMention('@"~/Library/Application Su', { start: 0, query: "~/Library/Application Su", quoted: true }, "~/Library/Application Support/")).toEqual({ text: '@"~/Library/Application Support/" ', caret: 34 });
    expect(insertMention('@"~/a b" next', { start: 0, query: "~/a b", quoted: true }, "~/a b c.md")).toEqual({ text: '@"~/a b c.md" next', caret: 14 });
  });
});
