import { describe, expect, test, vi } from "vitest";
import type { MrEvent } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("./listen", () => ({ listen: () => Promise.resolve(() => {}) }));
const { loadLog, reducer } = await import("./store");
const { initialState } = await import("./reduce");

const log: MrEvent[] = Array.from({ length: 12_345 }, (_, i) => ({ id: `E${String(i).padStart(6, "0")}`, session_id: "s1", kind: "sidecar.sdk", payload: {}, anchor: null, created_at: i }));
// The core's events_list: ORDER BY id, after a cursor, LIMIT.
const list = vi.fn(async ({ after, limit }: { after: string | null; limit: number }) => log.filter((e) => after === null || e.id > after).slice(0, limit));

describe("boot replay (MR-97)", () => {
  test("reads the whole log past any one page, newest events included", async () => {
    const all = await loadLog(list);
    expect(all).toHaveLength(log.length);
    expect(all[all.length - 1].id).toBe(log[log.length - 1].id);
    expect(list).toHaveBeenCalledTimes(3);
  });
});

const ev = (id: string, session_id: string | null, kind: string, payload: Record<string, unknown> = {}): MrEvent => ({ id, session_id, kind, payload, anchor: null, created_at: Number(id.slice(1)) });
const reply = (id: string) => ev(id, "old", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: `reply ${id}` }] } } });

describe("archived sessions load on demand (MR-162)", () => {
  test("boot asks the core to skip archived transcripts", async () => {
    list.mockClear();
    await loadLog(list);
    expect(list.mock.calls[0][0]).toMatchObject({ skipArchived: true });
  });

  test("an archived session replays partial, then its full history fills it in", () => {
    // What the core sends at boot: the archived session without its sidecar.sdk rows.
    const boot = [ev("A1", "old", "ui.session_requested", { prompt: "fix it", cwd: "/r" }), ev("A4", "old", "ui.session_archived"), ev("A5", "live", "ui.session_requested", { prompt: "go", cwd: "/r" })];
    const s0 = reducer(initialState, { type: "replay", events: boot });
    expect(s0.sessions.old.partial).toBe(true);
    expect(s0.sessions.live.partial).toBe(false);
    expect(s0.sessions.old.transcript).toHaveLength(0);
    const full = [boot[0], reply("A2"), ev("A3", null, "app.started"), reply("A35"), boot[1]];
    const s1 = reducer(s0, { type: "hydrate", id: "old", events: full });
    expect(s1.sessions.old.partial).toBe(false);
    expect(s1.sessions.old.transcript.map((t) => t.kind === "text" && t.text)).toEqual(["reply A2", "reply A35"]);
    expect(s1.sessions.old.archivedAt).toBe(4);
    expect(s1.sessions.live).toBe(s0.sessions.live);
  });
});
