import { describe, expect, it } from "vitest";
import { countLabels, lamps } from "./Overview";
import type { OverviewArea, OverviewBlock } from "../state/overview";

const block = (id: string, needs = false): OverviewBlock => ({ kind: "session", id, title: id, lamp: needs ? "needs_you" : "working", needs, status: "", step: null });

describe("Overview labels (decision 40)", () => {
  const c = { needs: 1, resume: 2, progress: 0, review: 3 };
  it("hides zero counts and spells the rest out up close", () => {
    expect(countLabels(c).map((l) => l.text)).toEqual(["⚠ 1 needs you", "↻ 2 resume", "◇ 3 review"]);
  });
  it("zoomed out, drops the words but never on what needs you, and keeps them as a tooltip", () => {
    const short = countLabels(c, true);
    expect(short.map((l) => l.text)).toEqual(["⚠ 1 needs you", "↻ 2", "◇ 3"]);
    expect(short.map((l) => l.title)).toEqual(["1 needs you", "2 resume", "3 review"]);
    expect(countLabels({ ...c, needs: 2 })[0].text).toBe("⚠ 2 need you");
  });
  it("the far view's lamp strip shows every open item, what needs you first", () => {
    const a = { groups: { resume: [block("r")], progress: [block("p"), block("ask", true)], review: [block("v")] } } as unknown as OverviewArea;
    expect(lamps(a).map((b) => b.id)).toEqual(["ask", "r", "p", "v"]);
  });
});
