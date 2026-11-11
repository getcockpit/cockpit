import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "./docs";
import type { SessionState } from "./types";

const sent: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: Record<string, unknown>) => { sent.push({ cmd, args }); return Promise.resolve(undefined); } }));
vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
const { buildDoc, decideQuestion, docRole, docsOf, groupByDoc } = await import("./docs");

const block = (id: string, section: string) => ({ id, section, status: "", takeaway: id, key: "", body: "", data: { options: [{ label: "A", description: "" }] }, order: 1, decision: null, updated: "" });
const brief: Doc = { id: "d1", title: "Catch-up: retries", session_id: "s1", version: 1, kind: "brief", blocks: { q_1: block("q_1", "question"), risk_1: block("risk_1", "risk") }, pending_notes: [], pending_changes: [] };
const session = { id: "s1", status: "working", cwd: "/x" } as SessionState;

beforeEach(() => { sent.length = 0; });


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

describe("doc tags on sessions", () => {
  test("the writer is tagged plan, Build it sessions build; briefs don't tag", () => {
    const plan: Doc = { id: "d2", title: "Retries", session_id: "p1", version: 1, blocks: {}, pending_notes: [], pending_changes: [], build_sessions: ["b1"] };
    expect(docRole([plan, brief], "p1")).toEqual({ doc: plan, role: "plan" });
    expect(docRole([plan, brief], "b1")).toEqual({ doc: plan, role: "build" });
    expect(docRole([plan, brief], "s1")).toBeNull();
  });
});

describe("doc groups on the Wall (MR-168)", () => {
  test("each doc gathers its plan then its builds; docs without sessions are idle; the rest stay loose", () => {
    const a: Doc = { id: "a", title: "A", session_id: "p1", version: 1, blocks: {}, pending_notes: [], pending_changes: [], build_sessions: ["b1", "b2"] };
    const b: Doc = { id: "b", title: "B", session_id: "p9", version: 1, blocks: {}, pending_notes: [], pending_changes: [] };
    const g = groupByDoc([a, b], ["b2", "x", "p1", "b1"]);
    expect(g.groups.map((x) => [x.doc.id, x.sessions.map((m) => `${m.role}:${m.id}`)])).toEqual([["a", ["plan:p1", "build:b2", "build:b1"]]]);
    expect(g.idle.map((d) => d.id)).toEqual(["b"]);
    expect(g.loose).toEqual(["x"]);
  });
});
