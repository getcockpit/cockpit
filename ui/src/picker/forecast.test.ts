import { describe, expect, test } from "vitest";
import { replay } from "../state/reduce";
import type { MrEvent, SessionState } from "../state/types";
import { DEFAULT_STEP_MS, forecast, headline, ordinal, typicalStep, type Upcoming } from "./forecast";

const MIN = 60_000;
let n = 0;
const ev = (sid: string, kind: string, payload: Record<string, unknown>, t: number): MrEvent => ({ id: `F${String(++n).padStart(5, "0")}`, session_id: sid, kind, payload, anchor: null, created_at: t });
const steps = (...xs: [string, string][]) => ({ steps: xs.map(([step, status]) => ({ step, status })) });
const running = (sid: string, kind = "blank", extra: MrEvent[] = []): SessionState =>
  replay([ev(sid, "ui.session_requested", { prompt: "x", cwd: "/r", kind }, 0), ev(sid, "sidecar.session_started", {}, 1), ...extra]).sessions[sid];

describe("forecast (MR-32)", () => {
  // Two finished steps of 2 and 4 minutes → a typical step of 3; the third started a minute ago.
  const s = running("a", "blank", [
    ev("a", "plan.updated", steps(["A", "doing"], ["B", "todo"], ["C", "todo"], ["D", "todo"]), 0),
    ev("a", "plan.updated", steps(["A", "done"], ["B", "doing"], ["C", "todo"], ["D", "todo"]), 2 * MIN),
    ev("a", "plan.updated", steps(["A", "done"], ["B", "done"], ["C", "doing"], ["D", "todo"]), 6 * MIN),
  ]);

  test("a typical step is the median of this session's finished steps", () => {
    expect(typicalStep(s, [s])).toBe(3 * MIN);
  });

  test("ETA = what's left of the current step + the rest", () => {
    expect(forecast(s, [s], 7 * MIN)).toMatchObject({ kind: "eta", at: 7 * MIN + 2 * MIN + 3 * MIN, ending: "done" });
  });

  test("a step running long still gets a quarter of a typical step", () => {
    const f = forecast(s, [s], 20 * MIN);
    expect(f.kind === "eta" && f.at).toBe(20 * MIN + 0.75 * MIN + 3 * MIN);
  });

  test("with no finished steps it borrows the log's, then four minutes", () => {
    const fresh = running("b", "plan", [ev("b", "plan.updated", steps(["A", "doing"]), 0)]);
    expect(typicalStep(fresh, [fresh, s])).toBe(3 * MIN);
    expect(typicalStep(fresh, [fresh])).toBe(DEFAULT_STEP_MS);
    expect(forecast(fresh, [fresh], 0)).toMatchObject({ kind: "eta", ending: "needs", label: "Spec ready for you" });
  });

  test("waiting on you is paused; no plan or not running gives no guess", () => {
    const asking = running("c", "blank", [ev("c", "plan.updated", steps(["A", "doing"]), 0), ev("c", "sidecar.permission_request", { request_id: "r", tool: "Bash", input: {} }, MIN)]);
    expect(forecast(asking, [asking], 2 * MIN).kind).toBe("paused");
    expect(forecast(running("d"), [], 0)).toEqual({ kind: "none", label: "No plan" });
    const ended = running("e", "blank", [ev("e", "plan.updated", steps(["A", "doing"]), 0), ev("e", "sidecar.session_ended", { ok: true }, MIN)]);
    expect(forecast(ended, [ended], 2 * MIN)).toEqual({ kind: "none", label: "Done" });
  });

  test("review flows end ready to review", () => {
    const r = running("f", "review", [ev("f", "plan.updated", steps(["A", "doing"]), 0)]);
    expect(forecast(r, [r], 0)).toMatchObject({ ending: "review", label: "Ready to review" });
  });
});

describe("headline (MR-32)", () => {
  const up = (title: string, at: number, ending: "needs" | "review" | "done"): Upcoming => ({ title, f: { kind: "eta", at, ending, label: "" } });
  const now = Date.UTC(2026, 9, 11, 14, 4);

  test("order only names who is next, never a minute count", () => {
    const h = headline(1, [up("infra", now + 3 * MIN, "done"), up("payments", now + 2 * MIN, "needs"), up("tests", now + 5 * MIN, "done")], now, false);
    expect(h).toBe("You're needed now; payments is next. Two sessions finish on their own.");
    expect(h).not.toMatch(/min|~/);
    expect(headline(0, [], now, false)).toBe("Nothing needs you now. Nothing running is expected to need you.");
  });

  test("with clock times it says when", () => {
    const h = headline(1, [up("payments", now + 2 * MIN, "needs"), up("infra", now + 3 * MIN, "done"), up("copy", now + 17 * MIN, "needs")], now, true);
    expect(h).toMatch(/^You're needed now, then again in ~2 min\. After that it's quiet until about [^.]+\. One session finishes on its own before then\.$/);
  });

  test("ordinals", () => {
    expect([0, 1, 2, 3].map(ordinal)).toEqual(["Next", "2nd", "3rd", "4th"]);
  });
});
