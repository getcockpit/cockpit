import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replay } from "./reduce";
import { AREA_GAP, AREA_W, bounds, detail, fit, overview, place, zoomAt } from "./overview";
import type { Doc } from "./docs";
import type { MrEvent } from "./types";

let n = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}, session: string | null = null): MrEvent => ({ id: `E${String(++n).padStart(5, "0")}`, session_id: session, kind, payload, anchor: null, created_at: 1_000_000 + n * 1000 });
const start = (id: string, workspace: string, prompt = id) => [ev("ui.session_requested", { prompt, cwd: "/w", workspace }, id), ev("sidecar.session_started", { sdk_session_id: `sdk-${id}`, model: "m" }, id)];
const todos = (id: string, done: number, total: number) => ev("sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "tool_use", id: `t${n}`, name: "TodoWrite", input: { todos: Array.from({ length: total }, (_, i) => ({ content: `step ${i + 1}`, activeForm: `Doing step ${i + 1}`, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) } }] } } }, id);
const result = (id: string, text = "ok") => ev("sidecar.sdk", { message: { type: "result", is_error: false, result: text } }, id);

// The real MR-2 probe session (sidecar/fixtures), replayed into the "ws_real" workspace.
function probe(): MrEvent[] {
  const raw = readFileSync(join(__dirname, "../../../sidecar/fixtures/probe.messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const out = [ev("ui.session_requested", { prompt: "probe", cwd: "/tmp/p", workspace: "ws_real" }, "probe")];
  for (const m of raw) {
    if (m.type === "system" && m.subtype === "init") out.push(ev("sidecar.session_started", { sdk_session_id: m.session_id, model: m.model }, "probe"));
    out.push(ev("sidecar.sdk", { message: m }, "probe"));
  }
  return out;
}

const doc = (id: string, session: string | null, extra: Partial<Doc> = {}): Doc => ({ id, title: id, session_id: session, version: 1, blocks: {}, pending_notes: [], pending_changes: [], ...extra });
const question = { q: { id: "q", section: "question", status: "draft", takeaway: "Which?", key: "", body: "", data: null, order: 0, decision: null, updated: "" } };

describe("Overview grouping (decision 40)", () => {
  const events = [
    ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" }),
    ev("ui.workspace_created", { id: "ws_real", name: "Real", config_dir: "/y" }),
    ...start("run", "personal"), todos("run", 1, 3),
    ...start("ask", "personal"), ev("sidecar.permission_request", { request_id: "p1", tool: "Bash", input: { command: "rm -rf build" } }, "ask"),
    ...start("rev", "personal"), todos("rev", 3, 3), result("rev"),
    ...start("done", "personal"), todos("done", 2, 2), result("done"), ev("sidecar.session_ended", { ok: true }, "done"),
    ...start("open", "personal"), todos("open", 1, 3), result("open"), ev("sidecar.session_ended", { ok: true }, "open"),
    ...start("err", "ws_b"), ev("sidecar.session_ended", { ok: false, reason: "boom" }, "err"),
    ...start("arch", "ws_b"), result("arch"), ev("ui.session_archived", {}, "arch"),
    ...probe(),
  ];
  const state = replay(events);
  // An app restart interrupts what was mid-turn: here, by hand, so the test doesn't depend on owners.
  state.sessions.int = { ...state.sessions.run, id: "int", workspace: "ws_b", status: "interrupted" };
  const docs = [
    doc("drafting", "rev", { blocks: question }),
    doc("ready", "rev"),
    doc("shipped", null, { shipped_at: 5 }),
    doc("brief", "rev", { kind: "brief" }),
    doc("archivedOwner", "arch"),
  ];
  const areas = overview(state, docs, {});
  const area = (ws: string) => areas.find((a) => a.workspace === ws)!;
  const ids = (ws: string, g: "resume" | "progress" | "review") => area(ws).groups[g].map((b) => b.id);

  it("has one rectangle per workspace, in tab order", () => {
    expect(areas.map((a) => a.name)).toEqual(["Personal", "Client B", "Real"]);
  });
  it("puts running and waiting-on-you work in progress, what needs you first", () => {
    expect(ids("personal", "progress")[0]).toBe("ask");
    expect(ids("personal", "progress")).toEqual(expect.arrayContaining(["ask", "run", "drafting"]));
    expect(area("personal").groups.progress.find((b) => b.id === "ask")).toMatchObject({ needs: true, lamp: "needs_you", status: "Needs you" });
  });
  it("puts finished plans and ready or shipped docs in review", () => {
    expect(ids("personal", "review")).toEqual(["rev", "ready", "shipped"]);
  });
  it("puts errors, interruptions and sessions that ended with steps open in resume", () => {
    expect(ids("personal", "resume")).toEqual(["open"]);
    expect(ids("ws_b", "resume").sort()).toEqual(["err", "int"]);
    expect(area("personal").groups.resume[0].status).toBe("Ended with 2 steps open");
  });
  it("leaves done work off the map: clean ends, archived sessions and their docs, briefs", () => {
    const all = areas.flatMap((a) => Object.values(a.groups).flat().map((b) => b.id));
    for (const gone of ["done", "arch", "archivedOwner", "brief"]) expect(all).not.toContain(gone);
  });
  it("never shows the question text on the map", () => {
    const lines = areas.flatMap((a) => Object.values(a.groups).flat().map((b) => b.status));
    expect(lines.some((l) => /rm -rf|Which\?|Asks:/.test(l))).toBe(false);
  });
  it("counts beside the name: needs you from the Wall's own queue, then each group", () => {
    expect(area("personal").counts).toEqual({ needs: 2, resume: 1, progress: 3, review: 3 });
    expect(area("ws_b").counts).toEqual({ needs: 0, resume: 2, progress: 0, review: 0 });
  });
  it("places the real probe session (it ended its turn idle) in its own workspace", () => {
    const real = area("ws_real");
    expect(Object.values(real.groups).flat().map((b) => b.id)).toEqual(["probe"]);
  });
});

describe("Overview layout", () => {
  it("lines new workspaces up to the right in tab order", () => {
    const at = place([{ workspace: "a", w: AREA_W, h: 100 }, { workspace: "b", w: AREA_W, h: 300 }], {});
    expect(at).toEqual({ a: { x: 0, y: 0 }, b: { x: AREA_W + AREA_GAP, y: 0 } });
  });
  it("keeps dragged spots and puts a new workspace in the first free spot right of them", () => {
    const at = place([{ workspace: "a", w: AREA_W, h: 100 }, { workspace: "new", w: AREA_W, h: 100 }], { a: { x: 400, y: -200 } });
    expect(at.a).toEqual({ x: 400, y: -200 });
    expect(at.new).toEqual({ x: 400 + AREA_W + AREA_GAP, y: -200 });
  });
  it("replays ui.overview_moved into the layout, and drops it with the workspace", () => {
    const base = [ev("ui.workspace_created", { id: "ws_x", name: "X", config_dir: "/x" })];
    const moved = replay([...base, ev("ui.overview_moved", { workspace: "ws_x", x: 120, y: -40 }), ev("ui.overview_moved", { workspace: "personal", x: 900, y: 0 })]);
    expect(moved.overviewLayout).toEqual({ ws_x: { x: 120, y: -40 }, personal: { x: 900, y: 0 } });
    expect(overview(moved, [], moved.overviewLayout).find((a) => a.workspace === "ws_x")).toMatchObject({ x: 120, y: -40 });
    expect(replay([...base, ev("ui.overview_moved", { workspace: "ws_x", x: "nope", y: 1 })]).overviewLayout).toEqual({});
    const gone = replay([...base, ev("ui.overview_moved", { workspace: "ws_x", x: 1, y: 1 }), ev("ui.workspace_deleted", { id: "ws_x", name: "X" })]);
    expect(gone.overviewLayout).toEqual({});
  });
  it("fits everything in view, never zooming past 1", () => {
    const box = bounds([{ x: 0, y: 0, w: 2000, h: 400 }, { x: 0, y: 600, w: 100, h: 400 }]);
    expect(box).toEqual({ x: 0, y: 0, w: 2000, h: 1000 });
    const cam = fit(box, { w: 1096, h: 800 });
    expect(cam.zoom).toBeCloseTo(0.5);
    expect(fit({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 1000 }).zoom).toBe(1);
  });
  it("zooms around the cursor and switches detail by zoom", () => {
    const cam = zoomAt({ x: 0, y: 0, zoom: 1 }, 100, 100, 2);
    expect(cam).toEqual({ zoom: 2, x: -100, y: -100 });
    expect([detail(0.2), detail(0.6), detail(1)]).toEqual(["far", "middle", "close"]);
  });
});
