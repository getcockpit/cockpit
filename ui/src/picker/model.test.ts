import { expect, test } from "vitest";
import { currentRow, modelLabel, prettyModel } from "./model";
import type { ModelRow } from "../state/types";

const rows: ModelRow[] = [
  { value: "default", resolved: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolved: "claude-opus-5-5", displayName: "Opus 5.5", description: "", efforts: ["low"] },
  { value: "sonnet", resolved: "claude-sonnet-5-5", displayName: "Sonnet", description: "Everyday", efforts: ["low", "medium", "high"] },
  { value: "haiku", resolved: "claude-haiku-5-5", displayName: "Haiku", description: "Fastest", efforts: [] },
];

test("model ids read as names", () => {
  expect(prettyModel("claude-opus-5-5[1m]")).toBe("Opus 5.5 · 1M context");
  expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(prettyModel("claude-fable-5-1")).toBe("Fable 5.1");
  expect(prettyModel("fake")).toBe("fake");
});

test("the chip names what runs now: your pick first, else what Claude Code reports", () => {
  expect(modelLabel({ model: "claude-opus-5-5[1m]", modelChoice: null, effort: null }, rows)).toEqual({ model: "Opus 5.5 · 1M context", effort: "default effort" });
  expect(modelLabel({ model: "claude-opus-5-5", modelChoice: "haiku", effort: "low" }, rows)).toEqual({ model: "Haiku", effort: "low" });
  expect(modelLabel({ model: null, modelChoice: "claude-sonnet-5-5", effort: null }, [])).toEqual({ model: "Sonnet 5.5", effort: "default effort" });
});

test("the picker's current row, for its effort levels", () => {
  expect(currentRow({ model: "claude-sonnet-5-5", modelChoice: null }, rows)?.value).toBe("sonnet");
  expect(currentRow({ model: "claude-opus-5-5[1m]", modelChoice: null }, rows)?.value).toBe("default");
  expect(currentRow({ model: "x", modelChoice: "haiku" }, rows)?.efforts).toEqual([]);
});
