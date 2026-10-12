import { describe, expect, it } from "vitest";
import { insertMention, matchPaths, typedMention } from "./mention";

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
