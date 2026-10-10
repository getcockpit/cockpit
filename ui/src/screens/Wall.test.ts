import { expect, test } from "vitest";
import { replay } from "../state/reduce";
import { resetLabel } from "./Wall";

// God-mode mark: the header showed "5-hour 10% · Week 64%" with no hint of when either limit resets.
test("both limit windows carry their reset time, shown as a short countdown", () => {
  const now = Date.UTC(2026, 9, 10, 12, 0) / 1000;
  const st = replay([{ id: "L1", session_id: null, kind: "sidecar.limits", payload: { available: true, five_hour: { utilization: 0.1, resetsAt: now + 2 * 3600 + 14 * 60 }, seven_day: { utilization: 0.64, resetsAt: now + 3 * 86400 } }, anchor: null, created_at: 1 }]);
  expect(st.usage.weeklyResetsAt).toBe(now + 3 * 86400);
  expect(resetLabel(st.usage.resetsAt, now * 1000)?.short).toBe("2h 14m");
  expect(resetLabel(now + 25 * 60, now * 1000)?.short).toBe("25m");
  expect(resetLabel(st.usage.weeklyResetsAt, now * 1000)?.short).toMatch(/^\D{2,}/);
  expect(resetLabel(st.usage.weeklyResetsAt, now * 1000)?.full).toMatch(/^Resets /);
  expect(resetLabel(null)).toBeNull();
});
