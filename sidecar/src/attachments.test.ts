import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userContent } from "./attachments";

const dir = mkdtempSync(join(tmpdir(), "mr-att-"));
const png = join(dir, "shot.png"), pdf = join(dir, "spec.pdf"), csv = join(dir, "rows.csv");
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(pdf, "%PDF-1.4");
writeFileSync(csv, "a,b\n1,2\n");

describe("userContent", () => {
  test("no attachments: the plain string", () => {
    expect(userContent("hi")).toBe("hi");
    expect(userContent("hi", [])).toBe("hi");
  });
  test("images and PDFs become blocks, every file is listed by path", () => {
    const c = userContent("look", [
      { path: png, name: "shot.png", mime: "image/png" },
      { path: pdf, name: "spec.pdf", mime: "" },
      { path: csv, name: "rows.csv", mime: "text/csv" },
    ]) as Record<string, any>[];
    expect(c.map((b) => b.type)).toEqual(["image", "document", "text"]);
    expect(c[0].source).toEqual({ type: "base64", media_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") });
    expect(c[1].source.media_type).toBe("application/pdf");
    expect(c[2].text).toStartWith("look\n\nAttached files:");
    expect(c[2].text).toContain(`- ${csv}\n`.trimEnd());
  });
  test("a missing file says so instead of failing", () => {
    const c = userContent("", [{ path: join(dir, "gone.png"), name: "gone.png", mime: "image/png" }]) as Record<string, any>[];
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain("missing");
  });
});
