import { describe, expect, it } from "vitest";
import { fileRef, splitPath } from "./paths";

describe("fileRef", () => {
  it("reads paths with and without a line", () => {
    expect(fileRef("src/auth.ts:42")).toEqual({ path: "src/auth.ts", line: 42 });
    expect(fileRef("ui/src/components/Turn.tsx:10:5")).toEqual({ path: "ui/src/components/Turn.tsx", line: 10 });
    expect(fileRef("docs/PRD.md")).toEqual({ path: "docs/PRD.md" });
    expect(fileRef("~/minority-report/scripts/dev.sh")).toEqual({ path: "~/minority-report/scripts/dev.sh" });
    expect(fileRef("/Users/me/notes.txt")).toEqual({ path: "/Users/me/notes.txt" });
    expect(fileRef("design/mockups/")).toEqual({ path: "design/mockups/" });
  });

  it("takes bare names only with a file extension", () => {
    expect(fileRef("Cargo.toml")).toEqual({ path: "Cargo.toml" });
    expect(fileRef("README.md")).toEqual({ path: "README.md" });
    expect(fileRef("api.start")).toBeNull();
    expect(fileRef("0.15.2")).toBeNull();
    expect(fileRef("useState")).toBeNull();
  });

  it("leaves commands, URLs and code alone", () => {
    expect(fileRef("bun test")).toBeNull();
    expect(fileRef("./scripts/dev.sh")).toBeNull(); // a command: it gets Run
    expect(fileRef("https://example.com/a.md")).toBeNull();
    expect(fileRef("a/b(c)")).toBeNull();
    expect(fileRef("var(--mr-well)")).toBeNull();
    expect(fileRef("src/*.ts")).toBeNull();
    expect(fileRef("/")).toBeNull();
    expect(fileRef("1/2")).toBeNull();
  });
});

describe("splitPath", () => {
  it("splits folder and name", () => {
    expect(splitPath("src/a/b.ts")).toEqual({ dir: "src/a/", name: "b.ts" });
    expect(splitPath("b.ts")).toEqual({ dir: "", name: "b.ts" });
    expect(splitPath("design/mockups/")).toEqual({ dir: "design/", name: "mockups/" });
  });
});
