import { describe, expect, test } from "vitest";
import { expandPastes, fileSize, foldsPaste, markPath, pasteToken, pastesIn, placeFile, segments } from "./compose";

describe("pasted text", () => {
  test("long or many-line pastes fold; short ones don't", () => {
    expect(foldsPaste("a short line")).toBe(false);
    expect(foldsPaste("x".repeat(801))).toBe(true);
    expect(foldsPaste(Array(13).fill("l").join("\n"))).toBe(true);
  });
  test("tokens expand back, deleted ones are gone", () => {
    const big = "line\n".repeat(20);
    const t = `look at ${pasteToken(1, big)} and ${pasteToken(2, "b")}`;
    expect(t).toContain("[Pasted text #1 · 21 lines]");
    expect(pastesIn(t)).toEqual([1, 2]);
    expect(expandPastes(t, { 1: big, 2: "b" })).toBe(`look at ${big} and b`);
    expect(expandPastes("[Pasted text #9 · 3 lines]", {})).toBe("[Pasted text #9 · 3 lines]");
  });
});

describe("segments", () => {
  test("files, a leading command and paste tokens are marked", () => {
    expect(segments("/review fix @src/a.ts, then @\"/x y/z.png\" [Pasted text #1 · 4 lines]")).toEqual([
      { text: "/review", kind: "command" },
      { text: " fix ", kind: "plain" },
      { text: "@src/a.ts", kind: "file" },
      { text: ", then ", kind: "plain" },
      { text: '@"/x y/z.png"', kind: "file" },
      { text: " ", kind: "plain" },
      { text: "[Pasted text #1 · 4 lines]", kind: "paste" },
    ]);
  });
  test("an email or a mid-word @ isn't a file; an unknown command isn't a command", () => {
    expect(segments("mail me@x.com").map((s) => s.kind)).toEqual(["plain"]);
    expect(segments("/nope x", (n) => n === "review")).toEqual([{ text: "/nope x", kind: "plain" }]);
  });
  test("the text survives the cut exactly", () => {
    const t = "a @b c\n@d/e. /f [Pasted text #2 · 9 lines]!";
    expect(segments(t).map((s) => s.text).join("")).toBe(t);
  });
  test("markPath strips @ and quotes", () => {
    expect(markPath("@src/a.ts")).toBe("src/a.ts");
    expect(markPath('@"/a b/c"')).toBe("/a b/c");
  });
});

describe("files", () => {
  test("images and PDFs attach; the folder's files and folders are mentioned", () => {
    expect(placeFile({ path: "/r/shot.png", mime: "image/png", dir: false }, "/r")).toEqual({ as: "attach" });
    expect(placeFile({ path: "/r/src/a.ts", mime: "application/octet-stream", dir: false }, "/r/")).toEqual({ as: "mention", text: "@src/a.ts" });
    expect(placeFile({ path: "/r/my docs", mime: "", dir: true }, "/r")).toEqual({ as: "mention", text: '@"my docs/"' });
    expect(placeFile({ path: "/elsewhere/data.csv", mime: "text/plain", dir: false }, "/r")).toEqual({ as: "attach" });
  });
  test("sizes", () => {
    expect([fileSize(912), fileSize(14_200), fileSize(3_240_000)]).toEqual(["912 B", "14 KB", "3.2 MB"]);
  });
});
