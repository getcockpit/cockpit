// bun test browser/lib.test.js — the overlay's pure helpers.
import { expect, test } from "bun:test";
const L = require("./extension/lib.js");

test("drag corners make a box either way", () => {
  expect(L.boxFrom({ x: 50, y: 40 }, { x: 10, y: 100 })).toEqual({ x: 10, y: 40, w: 40, h: 60 });
});

test("only secret fields near the crop are blacked out", () => {
  const area = { x: 100, y: 100, w: 50, h: 20 };
  const near = { x: 160, y: 100, w: 40, h: 20 }; // inside the 16px pad
  const far = { x: 400, y: 400, w: 40, h: 20 };
  expect(L.redactRects(area, [near, far, { x: 0, y: 0, w: 0, h: 0 }])).toEqual([near]);
});

test("counts, moves and the ⌥A toggle", () => {
  expect(L.countLine(1, 1)).toBe("1 pin");
  expect(L.countLine(9, 3)).toBe("9 pins in 3 tabs");
  expect(L.move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  expect(L.move(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  expect(L.isToggle({ altKey: true, code: "KeyA", target: { tagName: "DIV" } })).toBe(true);
  expect(L.isToggle({ altKey: true, code: "KeyA", target: { tagName: "INPUT" } })).toBe(false);
  expect(L.isToggle({ altKey: true, metaKey: true, code: "KeyA", target: { tagName: "DIV" } })).toBe(false);
});

test("secret field selector covers passwords, cards and one-time codes", () => {
  for (const s of ["input[type=password]", "cc-", "one-time-code", "cvv"]) expect(L.SECRET_FIELDS).toContain(s);
});
