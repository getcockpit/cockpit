import { describe, expect, test, vi } from "vitest";
import type { MrEvent } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("./listen", () => ({ listen: () => Promise.resolve(() => {}) }));
const { loadLog } = await import("./store");

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
