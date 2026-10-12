import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "./docs";
import type { SessionState } from "./types";

const sent: { cmd: string; args: Record<string, unknown> }[] = [];
let reply: unknown = null;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: Record<string, unknown>) => { sent.push({ cmd, args }); return Promise.resolve(cmd === "brief_continue" ? reply : undefined); } }));
vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
const { continueBrief, decideQuestion } = await import("./docs");

const block = (id: string, section: string) => ({ id, section, status: "", takeaway: id, key: "", body: "", data: { options: [{ label: "A", description: "" }] }, order: 1, decision: null, updated: "" });
const brief: Doc = { id: "d1", title: "Catch-up: retries", session_id: "s1", version: 1, kind: "brief", blocks: { q_1: block("q_1", "question"), risk_1: block("risk_1", "risk") }, pending_notes: [], pending_changes: [] };
const session = { id: "s1", status: "working", cwd: "/x" } as SessionState;

beforeEach(() => { sent.length = 0; });

describe("catch-up brief (MR-116)", () => {
  test("Continue with corrections sends them into the same session, even mid-turn", async () => {
    reply = "The user caught up… Resume from where you stopped.";
    expect(await continueBrief(brief, session)).toBe(true);
    expect(sent.map((x) => x.cmd)).toEqual(["brief_continue", "session_send"]);
    expect(sent[1].args).toEqual({ session: "s1", text: reply });
  });

  test("Continue with nothing to correct closes silently: no message, no turn", async () => {
    reply = null;
    expect(await continueBrief(brief, session)).toBe(false);
    expect(sent.map((x) => x.cmd)).toEqual(["brief_continue"]);
  });

  test("answering a brief's last question waits for Continue instead of sending feedback", async () => {
    await decideQuestion(brief, "q_1", "A", session);
    expect(sent.map((x) => x.cmd)).toEqual(["event_append"]);
  });
});
