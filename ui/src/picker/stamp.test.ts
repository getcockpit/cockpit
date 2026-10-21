import { describe, expect, it } from "vitest";
import { dayKey, dayLabel, minuteKey, ulidAt, ulidTime, whenLabel, clockTime } from "./stamp";

const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe("stamp", () => {
  const now = at(2026, 10, 21, 15, 0);
  it("labels days relative to now", () => {
    expect(dayLabel(at(2026, 10, 21, 0, 1), now)).toBe("Today");
    expect(dayLabel(at(2026, 10, 20, 23, 59), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 10, 19), now)).toMatch(/19/);
    expect(dayLabel(at(2025, 10, 19), now)).toMatch(/2025/);
  });
  it("shows just the clock today, the day too before", () => {
    expect(whenLabel(at(2026, 10, 21, 9, 5), now)).toBe(clockTime(at(2026, 10, 21, 9, 5)));
    expect(whenLabel(at(2026, 10, 20, 9, 5), now)).toBe(`Yesterday ${clockTime(at(2026, 10, 20, 9, 5))}`);
  });
  it("keys minutes and days locally", () => {
    expect(minuteKey(at(2026, 10, 21, 9, 5, 1))).toBe(minuteKey(at(2026, 10, 21, 9, 5, 59)));
    expect(minuteKey(at(2026, 10, 21, 9, 5))).not.toBe(minuteKey(at(2026, 10, 21, 9, 6)));
    expect(dayKey(at(2026, 10, 21, 0, 0))).toBe(dayKey(at(2026, 10, 21, 23, 59)));
  });
  it("reads the time out of a ULID", () => {
    // The first 10 characters are the ms, big-endian Crockford base32.
    const ms = at(2026, 10, 21, 10, 44, 11) + 123;
    expect(ulidTime(ulidAt(ms))).toBe(ms);
    expect(ulidTime(`${ulidAt(ms).slice(0, 10).toLowerCase()}tsv4rrffq69g5fav`)).toBe(ms);
    // A real event id from the log, and the created_at stored beside it.
    expect(ulidTime("01M5ET47DDVZ2B2W2BZYVHWQ2S")).toBe(1792572267949);
    expect(ulidTime("")).toBeNull();
    expect(ulidTime("not-a-ulid")).toBeNull();
  });
});
