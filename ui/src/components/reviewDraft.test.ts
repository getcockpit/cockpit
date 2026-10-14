import { describe, expect, it } from "vitest";
import { arrowHead, askOf, inkLabel, attachmentNotes, clearDrafts, compareReply, getDrafts, hasInput, nameOf, resolvePath, reviewReply, setDraft } from "./reviewDraft";

describe("image review", () => {
  it("reads ask, defaulting to both", () => {
    expect(askOf(undefined)).toEqual({ verdict: true, pins: true });
    expect(askOf("verdict")).toEqual({ verdict: true, pins: false });
    expect(askOf("pins")).toEqual({ verdict: false, pins: true });
    expect(askOf("none")).toEqual({ verdict: false, pins: false });
  });

  it("resolves relative paths against the session folder and leaves URLs alone", () => {
    expect(resolvePath("shots/a.png", "/repo/")).toBe("/repo/shots/a.png");
    expect(resolvePath("./a.png", "/repo")).toBe("/repo/a.png");
    expect(resolvePath("/tmp/a.png", "/repo")).toBe("/tmp/a.png");
    expect(resolvePath("https://x.dev/a.png?v=2", "/repo")).toBe("https://x.dev/a.png?v=2");
    expect(nameOf("https://x.dev/img/a.png?v=2")).toBe("a.png");
    expect(nameOf("data:image/png;base64,AAA")).toBe("inline image");
    expect(reviewReply([{ path: "data:image/png;base64,AAA", caption: "Mock" }], [{ verdict: "approve", pins: [] }])).toBe("Image review (1 image):\n1. ✓ Approved · Mock");
  });

  it("sends one reply with every verdict, comment and pin", () => {
    const text = reviewReply(
      [{ path: "/r/login.png", caption: "Login" }, { path: "/r/home.png" }, { path: "/r/menu.png" }],
      [{ verdict: "reject", comment: " logo clipped ", pins: [{ x: 42.4, y: 18.6, note: "button overlaps logo" }] }, { verdict: "approve", pins: [] }, { pins: [] }],
    );
    expect(text).toBe([
      "Image review (3 images):",
      '1. ✗ Rejected · Login (/r/login.png): "logo clipped"',
      "   - Pin 1 at (42% from left, 19% from top): button overlaps logo",
      "2. ✓ Approved · home.png (/r/home.png)",
      "3. No verdict · menu.png (/r/menu.png)",
    ].join("\n"));
  });

  it("describes a before/after review with pins on each side", () => {
    const text = compareReply("/a.png", "/b.png", { verdict: "approve", pins: [{ x: 10, y: 90, note: "" }] }, { pins: [{ x: 50, y: 50, note: "was here" }] });
    expect(text).toContain("Before/after review: ✓ Approved · a.png → b.png");
    expect(text).toContain("On the before image:\n- Pin 1 at (50% from left, 50% from top): was here");
    expect(text).toContain("On the after image:\n- Pin 1 at (10% from left, 90% from top)");
  });

  it("appends notes only for attachments that have pins", () => {
    const pins = { "/d/a.png": [{ x: 1, y: 2, note: "here" }] } as Record<string, { x: number; y: number; note: string }[]>;
    const files = [{ path: "/d/a.png", name: "a.png" }, { path: "/d/b.png", name: "b.png" }];
    expect(attachmentNotes(files, (p) => ({ pins: pins[p] ?? [] }))).toBe("Notes on a.png (/d/a.png):\n- Pin 1 at (1% from left, 2% from top): here");
    expect(attachmentNotes(files, () => ({ pins: [] }))).toBe("");
    expect(attachmentNotes(files, (p) => ({ pins: [], ink: p === "/d/b.png" ? [{ kind: "line" as const, pts: [[10, 10], [30, 20]] as [number, number][] }] : [] }), { "/d/b.png": "/data/b-drawn.png" }))
      .toBe("Notes on b.png (/d/b.png):\n- Drawing 1 around (10%–30% from left, 10%–20% from top)\n- Drawn-on copy attached: /data/b-drawn.png");
  });

  it("names each drawing by the box around it and points at the drawn-on copy", () => {
    const text = reviewReply([{ path: "/r/a.png" }], [{ pins: [], ink: [{ kind: "line", pts: [[20.2, 40], [35.6, 41], [50, 60.4]] }, { kind: "line", pts: [[70, 70]] }] }], ["/data/a-drawn.png"]);
    expect(text).toBe([
      "Image review (1 image):",
      "1. Comment · a.png (/r/a.png)",
      "   - Drawing 1 around (20%–50% from left, 40%–60% from top)",
      "   - Drawing 2 around (70% from left, 70% from top)",
      "   - Drawn-on copy: /data/a-drawn.png",
    ].join("\n"));
  });

  it("names arrows by start and target and boxes by area, numbered per kind", () => {
    const text = reviewReply([{ path: "/r/a.png" }], [{ pins: [], ink: [{ kind: "box", a: [60, 40], b: [20, 10] }, { kind: "arrow", a: [10, 90], b: [45.4, 52] }, { kind: "box", a: [1, 1], b: [5, 5] }] }]);
    expect(text.split("\n").slice(2)).toEqual([
      "   - Box 1 around (20%–60% from left, 10%–40% from top)",
      "   - Arrow 1 from (10%, 90%) pointing at (45% from left, 52% from top)",
      "   - Box 2 around (1%–5% from left, 1%–5% from top)",
    ]);
  });

  it("quotes a box's label and places it over the box, or inside at the top edge", () => {
    const text = reviewReply([{ path: "/r/a.png" }], [{ pins: [], ink: [{ kind: "box", a: [20, 40], b: [60, 50], label: " overlaps logo " }, { kind: "box", a: [0, 0], b: [10, 10], label: "  " }] }]);
    expect(text).toContain('- Box 1 "overlaps logo" around (20%–60% from left, 40%–50% from top)');
    expect(text).toContain("- Box 2 around (0%–10% from left, 0%–10% from top)");
    const over = inkLabel({ kind: "box", a: [60, 50], b: [20, 40], label: "x" }, 1000, 500)!;
    expect(over.size).toBe(25);
    expect(over.y).toBeLessThan(200); // above the box's top at 200 px
    expect(inkLabel({ kind: "box", a: [0, 0], b: [10, 10], label: "x" }, 1000, 500)!.y).toBeGreaterThan(0);
    expect(inkLabel({ kind: "box", a: [0, 0], b: [10, 10] }, 1000, 500)).toBeNull();
    expect(inkLabel({ kind: "arrow", a: [0, 0], b: [10, 10] }, 1000, 500)).toBeNull();
  });

  it("puts the arrowhead's corners behind the tip, either side of the shaft", () => {
    const [l, r] = arrowHead([0, 0], [10, 0], 2);
    expect(l[0]).toBeLessThan(10);
    expect(r[0]).toBeLessThan(10);
    expect(Math.sign(l[1])).toBe(-Math.sign(r[1]));
  });

  it("keeps drafts per key until cleared", () => {
    setDraft("v:1", 1, { verdict: "approve" });
    const d = getDrafts("v:1", 2);
    expect(d[0]).toEqual({ pins: [] });
    expect(d[1].verdict).toBe("approve");
    expect(hasInput(d)).toBe(true);
    clearDrafts("v:1");
    expect(hasInput(getDrafts("v:1", 2))).toBe(false);
  });
});
