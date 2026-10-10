import { describe, expect, test } from "vitest";
import { replay } from "./reduce";
import { nowLine, QUIET_MS } from "../picker/now";
import { sessionTitle } from "../picker/title";
import { proposedReplies, withoutReplyLine } from "../picker/queue";
import { nextReplies } from "../screens/Focus";
import type { MrEvent, TranscriptItem } from "./types";

// MR-59: is my message queued, being worked on, or answered — and is anything happening at all?
let n = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}, session: string | null = "s1"): MrEvent => ({ id: `E${String(++n).padStart(4, "0")}`, session_id: session, kind, payload, anchor: null, created_at: 1_000_000 + n * 1000 });
const sdk = (message: Record<string, unknown>) => ev("sidecar.sdk", { message });
const toolUse = (id: string, command: string) => sdk({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command, description: `Run ${command}` } }] } });
const toolResult = (id: string) => sdk({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const text = (t: string) => sdk({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const result = () => sdk({ type: "result", subtype: "success", result: "done" });
const sent = (t: string) => ev("ui.message_sent", { text: t });
const start = () => [ev("sidecar.ready", {}, null), ev("ui.session_requested", { prompt: "go", cwd: "/tmp" }), ev("sidecar.session_started", { sdk_session_id: "x" })];
const marks = (items: TranscriptItem[]) => items.flatMap((t) => (t.kind === "user" ? [`${t.text}:${t.delivery}`] : []));

describe("message delivery", () => {
  test("sent while idle: sending → Claude has it → answered", () => {
    const base = [...start(), text("hi"), result()];
    expect(marks(replay([...base, sent("a")]).sessions.s1.transcript)).toEqual(["a:sending"]);
    expect(marks(replay([...base, sent("a"), text("ok")]).sessions.s1.transcript)).toEqual(["a:taken"]);
    expect(marks(replay([...base, sent("a"), text("ok"), result()]).sessions.s1.transcript)).toEqual(["a:answered"]);
  });

  test("sent mid-turn: queued until the next tool result hands it over", () => {
    const base = [...start(), toolUse("t1", "cargo test")];
    expect(marks(replay([...base, sent("stop")]).sessions.s1.transcript)).toEqual(["stop:queued"]);
    expect(marks(replay([...base, sent("stop"), toolResult("t1")]).sessions.s1.transcript)).toEqual(["stop:taken"]);
  });

  test("queued when the turn ends: the session stays working and the next turn takes it", () => {
    const base = [...start(), toolUse("t1", "cargo test"), sent("then lint"), text("tests pass"), result()];
    const s = replay(base).sessions.s1;
    expect(marks(s.transcript)).toEqual(["then lint:queued"]);
    expect(s.status).toBe("working");
    expect(marks(replay([...base, text("linting")]).sessions.s1.transcript)).toEqual(["then lint:taken"]);
  });

  test("the session ends before Claude reads it: not delivered", () => {
    const s = replay([...start(), toolUse("t1", "x"), sent("hey"), ev("sidecar.session_ended", { ok: false, reason: "boom" })]).sessions.s1;
    expect(marks(s.transcript)).toEqual(["hey:lost"]);
  });
});

describe("now line", () => {
  test("names the running tool and goes stale after a quiet minute", () => {
    const s = replay([...start(), toolUse("t1", "cargo test")]).sessions.s1;
    const fresh = nowLine(s, s.heardAt + 5000)!;
    expect(fresh.label).toBe("Run cargo test");
    expect(fresh.stale).toBe(false);
    expect(nowLine(s, s.heardAt + QUIET_MS)!.stale).toBe(true);
  });

  test("sending to a long-idle session is not silence", () => {
    const s = replay([...start(), text("hi"), result(), sent("go on")]).sessions.s1;
    const sentAt = s.transcript.at(-1)!.at;
    expect(nowLine(s, sentAt + 5000)!.stale).toBe(false);
    expect(nowLine(s, sentAt + QUIET_MS)!.stale).toBe(true);
  });

  test("a queued message says Claude finishes its step first", () => {
    const s = replay([...start(), toolUse("t1", "x"), sent("wait")]).sessions.s1;
    expect(nowLine(s)!.label).toMatch(/then reading your message/);
  });

  test("nothing when the turn is over", () => {
    expect(nowLine(replay([...start(), text("hi"), result()]).sessions.s1)).toBeNull();
  });
});

describe("composed views (MR-61)", () => {
  test("view.rendered becomes a transcript item with its catalog blocks", () => {
    const blocks = [{ type: "tally", items: [{ n: 3, label: "fixed", tone: "done" }] }, { type: "next", text: "Ship it?", replies: ["Open a PR"] }];
    const s = replay([...start(), ev("view.rendered", { title: "Status", blocks })]).sessions.s1;
    const v = s.transcript.at(-1);
    expect(v?.kind).toBe("view");
    expect(v && v.kind === "view" ? [v.title, v.blocks.length] : null).toEqual(["Status", 2]);
  });
});

describe("plan (MR-62)", () => {
  const plan = (steps: [string, string][]) => ev("plan.updated", { steps: steps.map(([step, status]) => ({ step, status })) });
  test("plan.updated becomes the session plan; a step keeps its start time while in progress", () => {
    const first = plan([["Read", "done"], ["Fix", "doing"], ["Test", "todo"]]);
    const s1 = replay([...start(), first]).sessions.s1;
    expect(s1.todos.map((x) => x.status)).toEqual(["completed", "in_progress", "pending"]);
    const since = s1.todos[1].since;
    const s2 = replay([...start(), first, plan([["Read", "done"], ["Fix", "doing"], ["Test", "todo"], ["Ship", "todo"]])]).sessions.s1;
    expect(s2.todos[1].since).toBe(since);
    expect(s2.todos).toHaveLength(4);
    const s3 = replay([...start(), first, plan([["Read", "done"], ["Fix", "done"], ["Test", "doing"]])]).sessions.s1;
    expect(s3.todos[2].since).toBeGreaterThan(since!);
  });
});

describe("titles and next steps (MR-63)", () => {
  test("your name beats Claude's title beats the first prompt; clearing hands it back", () => {
    const base = [...start(), ev("session.titled", { title: "Plan panel for live progress" })];
    expect(sessionTitle(replay(base).sessions.s1)).toBe("Plan panel for live progress");
    const named = [...base, ev("ui.session_renamed", { name: "My plan work" }), ev("session.titled", { title: "Something else" })];
    expect(sessionTitle(replay(named).sessions.s1)).toBe("My plan work");
    expect(sessionTitle(replay([...named, ev("ui.session_renamed", { name: "" })]).sessions.s1)).toBe("Something else");
    expect(sessionTitle(replay(start()).sessions.s1)).toBe("go");
  });

  test("Claude's Next line becomes the replies; no hard-coded fallback", () => {
    expect(proposedReplies('Done.\n\nNext: "Merge it" · "Show me the diff"')).toEqual(["Merge it", "Show me the diff"]);
    expect(proposedReplies("**Next:** “Run the suite” or “Ship it”")).toEqual(["Run the suite", "Ship it"]);
    expect(withoutReplyLine('All green.\n\nNext: "Merge it" · "Show me the diff"')).toBe("All green.");
    expect(withoutReplyLine('All green.\nNext: decide whether to "merge" now')).toContain("Next:");
    const s = replay([...start(), text('Fixed it.\n\nNext: "Open a PR" · "Run the tests"'), result()]).sessions.s1;
    expect(nextReplies(s)).toEqual(["Open a PR", "Run the tests"]);
    expect(nextReplies(replay([...start(), text("Fixed it."), result()]).sessions.s1)).toEqual([]);
  });
});

describe("one-click update (MR-66)", () => {
  const up = (kind: string, payload: Record<string, unknown> = {}) => ev(kind, payload, null);
  test("building → ready → restart → what's new, and a failure keeps its step and log", () => {
    const base = [...start(), up("update.started", { subjects: ["Live titles"] }), up("update.step", { step: "app" })];
    expect(replay(base).update.phase).toBe("building");
    expect(replay(base).update.step).toBe("app");
    const ready = [...base, up("update.finished", { ok: true })];
    expect(replay(ready).update.phase).toBe("ready");
    const after = replay([...ready, up("update.restarting", { subjects: ["Live titles"] }), up("app.started", { sha: "x" })]);
    expect(after.update.phase).toBe("idle");
    expect(after.update.whatsNew).toEqual(["Live titles"]);
    expect(replay([...ready, up("update.restarting", { subjects: ["Live titles"] }), up("app.started"), up("ui.update_seen")]).update.whatsNew).toBeNull();
    const failed = replay([...base, up("update.finished", { ok: false, step: "app", log: "error[E0425]" })]).update;
    expect([failed.phase, failed.step, failed.log]).toEqual(["failed", "app", "error[E0425]"]);
    expect(replay([...base, up("app.started")]).update.whatsNew).toBeNull(); // a plain restart isn't an update
  });
});
