import { describe, expect, test, vi } from "vitest";
import type { QueueItem } from "../picker/queue";
import type { Doc } from "./docs";
import { replay } from "./reduce";
import type { MrEvent, PendingAsk, SessionState } from "./types";

const sent: { cmd: string; args: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => { sent.push({ cmd, args }); return Promise.resolve(); } }));
vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
const { answerFrom, cleanAction, noteFor, targetFor } = await import("./notify");

let n = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}, session: string | null = "s1"): MrEvent => ({ id: `E${String(++n).padStart(4, "0")}`, session_id: session, kind, payload, anchor: null, created_at: 1_000_000 + n * 1000 });
const s: SessionState = { ...replay([ev("sidecar.ready", {}, null), ev("ui.session_requested", { prompt: "Fix the login redirect", cwd: "/Users/me/shop" })]).sessions.s1, workspace: "work" };
const sessions = { s1: s };
const ask = (a: PendingAsk): QueueItem => ({ kind: "ask", key: `ask:${a.requestId}`, s, a, at: 1 });
const none = () => null;

describe("notifications (MR-94)", () => {
  test("a command permission says what it runs, where, and offers Allow / Deny", () => {
    const note = noteFor(ask({ kind: "permission", requestId: "r1", tool: "Bash", input: { command: "rm -rf build", description: "Clean the build" }, suggestions: null, reason: null, at: 1 }), sessions, none);
    expect(note.title).toBe("Allow a risky command?");
    expect(note.subtitle).toMatch(/^shop \/ /);
    expect(note.body).toBe("Clean the build\n$ rm -rf build");
    expect(note.actions).toEqual(["Allow", "Deny"]);
    expect(note.session).toBe("s1");
  });

  test("a question offers its options; a multi-question one only opens", () => {
    const q = { question: "Which database?", header: "Database", options: [{ label: "Postgres, managed", description: "" }, { label: "SQLite", description: "" }] };
    expect(noteFor(ask({ kind: "question", requestId: "r2", questions: [q], input: {}, at: 1 }), sessions, none)).toMatchObject({ title: "Claude asks: Database", body: "Which database?", actions: ["Postgres, managed", "SQLite"] });
    expect(noteFor(ask({ kind: "question", requestId: "r3", questions: [q, q], input: {}, at: 1 }), sessions, none)).toMatchObject({ body: "Which database? (+1 more)", actions: [] });
  });

  test("a prose ask without choices gets a reply field; the workspace names itself when there are several", () => {
    const item: QueueItem = { kind: "prose", key: "prose:t1", s, question: "What should the export be called?", options: [], at: 1 };
    expect(noteFor(item, sessions, (id) => (id === "work" ? "Work" : null))).toMatchObject({ reply: true, actions: [], subtitle: expect.stringMatching(/^Work · shop \/ /) });
  });

  test("clicking lands on the session in its workspace, or on the doc", () => {
    expect(targetFor(ask({ kind: "permission", requestId: "r1", tool: "Read", input: {}, suggestions: null, reason: null, at: 1 }), sessions)).toEqual({ workspace: "work", session: "s1", doc: null });
    const d = { id: "d1", title: "Plan", session_id: "s1", version: 1, blocks: {}, pending_notes: [], pending_changes: [] } as Doc;
    const b = { id: "b1", section: "question", status: "", takeaway: "Which queue?", key: "", body: "", data: null, order: 0, decision: null, updated: "" };
    expect(targetFor({ kind: "doc", key: "doc:d1:b1", d, b, at: 0 }, sessions)).toEqual({ workspace: "work", session: null, doc: "d1" });
  });

  test("answers from the notification go where the in-app buttons send them", async () => {
    sent.length = 0;
    const a: PendingAsk = { kind: "question", requestId: "r2", questions: [{ question: "Which database?", header: "", options: [{ label: "Postgres, managed", description: "" }] }], input: {}, at: 1 };
    // macOS returns the comma-free label the core showed; it maps back to the real one.
    expect(await answerFrom(ask(a), { kind: "action", value: cleanAction("Postgres, managed") }, sessions)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ cmd: "permission_respond", args: { requestId: "r2", decision: { behavior: "allow", updatedInput: { answers: { "Which database?": "Postgres, managed" } } } } });
    const prose: QueueItem = { kind: "prose", key: "prose:t1", s, question: "Name?", options: [], at: 1 };
    expect(await answerFrom(prose, { kind: "reply", value: "invoices.csv" }, sessions)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ cmd: "session_send", args: { session: "s1", text: "invoices.csv" } });
    expect(await answerFrom(prose, { kind: "open" }, sessions)).toBe(false);
  });
});
