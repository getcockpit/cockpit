import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "./docs";
import type { SessionState } from "./types";

const sent: { cmd: string; args: Record<string, unknown> }[] = [];
let reply: unknown = null;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: Record<string, unknown>) => { sent.push({ cmd, args }); return Promise.resolve(cmd === "brief_continue" ? reply : undefined); } }));
vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
const { buildDoc, continueBrief, continueLabel, decideQuestion, docsOf, isDecision } = await import("./docs");

const block = (id: string, section: string) => ({ id, section, status: "", takeaway: id, key: "", body: "", data: { options: [{ label: "A", description: "" }] }, order: 1, decision: null, updated: "" });
const brief: Doc = { id: "d1", title: "Catch-up: retries", session_id: "s1", version: 1, kind: "brief", blocks: { q_1: block("q_1", "question"), risk_1: block("risk_1", "risk") }, pending_notes: [], pending_changes: [] };
const session = { id: "s1", status: "working", cwd: "/x" } as SessionState;

beforeEach(() => { sent.length = 0; });

describe("catch-up brief (MR-116)", () => {
  test("Continue says it applies your decisions, and counts corrections apart (I90)", () => {
    expect(["Decided \"Record it?\": Record it now", "Confirmed this looks wrong: \"x\" (y)"].map(isDecision)).toEqual([true, false]);
    expect(continueLabel(2, 1)).toBe("Apply 2 decisions + 1 correction and continue");
    expect(continueLabel(1, 0)).toBe("Apply 1 decision and continue");
    expect(continueLabel(0, 3)).toBe("Continue with 3 corrections");
    expect(continueLabel(0, 0)).toBe("Continue, nothing to correct");
  });
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

describe("build session linked to its doc (MR-118)", () => {
  const plan: Doc = { ...brief, id: "d2", kind: "", session_id: "p1", build_sessions: ["b1"] };
  test("Focus shows a doc to the session that wrote it and the one building it", () => {
    expect(docsOf([plan], "p1")).toEqual([plan]);
    expect(docsOf([plan], "b1")).toEqual([plan]);
    expect(docsOf([plan], "other")).toEqual([]);
  });
  test("Build it starts the session in the plan's folder, then links it to the doc", async () => {
    await buildDoc(plan, session);
    expect(sent.map((x) => x.cmd)).toEqual(["session_start", "doc_build_started"]);
    expect(sent[0].args.cwd).toBe("/x");
    expect(sent[1].args.docId).toBe("d2");
  });
});
