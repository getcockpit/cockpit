import { describe, expect, it } from "vitest";
import { comboOf, summarize, usageLabel, type UsageRow } from "./usage";

const key = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code, key: code, ...mods });

describe("usage", () => {
  it("names shortcuts by physical key and skips typing", () => {
    expect(comboOf(key("KeyK", { metaKey: true }), false)).toBe("⌘K");
    expect(comboOf(key("KeyG", { metaKey: true, shiftKey: true }), false)).toBe("⇧⌘G");
    expect(comboOf(key("Tab", { ctrlKey: true }), false)).toBe("⌃Tab");
    expect(comboOf(key("KeyT"), false)).toBeNull();
    expect(comboOf(key("KeyV", { metaKey: true }), true)).toBeNull();
    expect(comboOf(key("MetaLeft", { metaKey: true }), false)).toBeNull();
  });

  it("groups used features and lists the quiet ones", () => {
    const row = (kind: UsageRow["kind"], name: string, count: number, total = count, detail = ""): UsageRow => ({ kind, name, detail, count, total, last_at: 1 });
    const s = summarize([row("click", "Key", 2, 5, "Approve"), row("click", "Tile", 9), row("view", "settings", 0, 3), row("action", "model_set", 1)]);
    expect(s.total).toBe(12);
    expect(s.groups.find((g) => g.kind === "click")!.rows.map((r) => r.name)).toEqual(["Tile", "Key"]);
    expect(s.quiet.map((r) => r.name)).toEqual(["settings"]);
    expect(usageLabel(row("click", "Key", 1, 1, "Approve"))).toBe("Approve · Key");
    expect(usageLabel(row("action", "model_set", 1))).toBe("model set");
  });
});
