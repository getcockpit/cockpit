import { describe, expect, it } from "vitest";
import { replay } from "../state/reduce";
import { needsQueue } from "./queue";
import { pickDecision } from "./pick";
import { outsidePending } from "./queue";
import { noteFor, targetFor } from "../state/notify";
import type { MrEvent } from "../state/types";

// Prompts from Claude Code sessions in a terminal (MR-219): queued until answered in Cockpit, in
// the pane, or the session goes away; a restart drops them (their relays hung up).
let n = 0;
const ev = (kind: string, payload: Record<string, unknown>): MrEvent => ({ id: `E${String(++n).padStart(4, "0")}`, session_id: null, kind, payload, anchor: null, created_at: 1_000_000 + n * 1000 });
const prompt = (id: string, command = "rm -rf dist") => ev("hook.prompt", { id, session_id: "abc", tool: "Bash", input: { command }, cwd: "/Users/me/shop", repo: "/Users/me/shop", branch: "main", pane: "%3", term: "tmux" });

describe("terminal prompts", () => {
  it("queue up, oldest first, until answered, resolved in the pane, or gone", () => {
    const s = replay([prompt("h1"), prompt("h2", "ls"), prompt("h3")]);
    expect(s.outside.map((o) => o.id)).toEqual(["h1", "h2", "h3"]);
    expect(s.outside[0]).toMatchObject({ tool: "Bash", cwd: "/Users/me/shop", branch: "main", pane: "%3", input: { command: "rm -rf dist" } });
    const after = replay([prompt("h1"), prompt("h2"), prompt("h3"), ev("hook.answer", { id: "h1", behavior: "allow" }), ev("hook.resolved_elsewhere", { id: "h2" }), ev("hook.gone", { id: "h3" })]);
    expect(after.outside).toEqual([]);
  });

  it("are dropped on restart: the relays hung up and the pane alone asks", () => {
    expect(replay([prompt("h1"), ev("app.started", {})]).outside).toEqual([]);
  });

  it("are in the needs-you queue with the same card and risk as a session's prompt", () => {
    const s = replay([prompt("h1")]);
    const q = needsQueue([], [], s.outside);
    expect(q).toHaveLength(1);
    expect(q[0].kind).toBe("outside");
    const { spec } = pickDecision(outsidePending(s.outside[0]));
    expect(spec.component).toBe("CommandCard");
    if (spec.component === "CommandCard") expect(spec.risk).toBe("high");
  });

  it("notify with Allow / Deny and land on Personal", () => {
    const s = replay([prompt("h1")]);
    const item = needsQueue([], [], s.outside)[0];
    const note = noteFor(item, {}, () => null);
    expect(note.actions).toEqual(["Allow", "Deny"]);
    expect(note.title).toBe("Allow a risky command?");
    expect(note.subtitle).toBe("Terminal · shop · main");
    expect(note.body).toBe("$ rm -rf dist");
    expect(targetFor(item, {})).toEqual({ workspace: "personal", session: null, doc: null });
  });
});
