import { describe, expect, test } from "vitest";
import { replay } from "./reduce";
import { nowLine, QUIET_MS } from "../picker/now";
import { sessionTitle } from "../picker/title";
import { proposedReplies, withoutReplyLine } from "../picker/queue";
import { groupSteps, nextReplies } from "../screens/Focus";
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

describe("transcript grouped by plan step (MR-69)", () => {
  const plan = (doing: number) => ev("plan.updated", { steps: ["Read", "Fix", "Test"].map((step, i) => ({ step, status: i < doing ? "done" : i === doing ? "doing" : "todo" })) });
  test("items take the step in progress; routine tools fold, signal stays outside", () => {
    const failing = sdk({ type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "x" } }] } });
    const failed = sdk({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "boom", is_error: true }] } });
    const s = replay([...start(), text("Before any plan"), plan(0), toolUse("t1", "cat a"), toolUse("t2", "cat b"), text("Found it"), plan(1), toolUse("t3", "edit"), failing, failed]).sessions.s1;
    expect(s.transcript.find((x) => x.kind === "text" && x.text === "Before any plan")?.step).toBeUndefined();
    expect(s.transcript.filter((x) => x.step === "Read").length).toBe(3);
    const rows = groupSteps(s.transcript);
    const steps = rows.filter((r) => r.kind === "step") as Extract<(typeof rows)[number], { kind: "step" }>[];
    expect(steps.map((g) => [g.step, g.tools.length, g.signal.map((x) => x.kind)])).toEqual([["Read", 2, ["text"]], ["Fix", 1, ["tool"]]]);
    expect(rows[0].kind).toBe("text"); // the pre-plan reply stays loose
  });
});

describe("background tasks (god-mode mark: started tasks weren't shown)", () => {
  // From the marked session: three quick commands, then a backgrounded benchmark whose tool result
  // came back at once, so the fold showed "Ran 4 commands ✓" while it was still running.
  const bg = (id: string, desc: string) => sdk({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "./bench.sh", description: desc, run_in_background: true } }] } });
  const started = (id: string, is_backgrounded: boolean) => sdk({ type: "system", subtype: "task_started", task_id: `b-${id}`, tool_use_id: id, is_backgrounded, task_type: "local_bash", description: "Run overhead benchmark (12 runs)" });
  const notified = (id: string, status: string) => sdk({ type: "system", subtype: "task_notification", task_id: `b-${id}`, tool_use_id: id, status, summary: `Background command "Run overhead benchmark (12 runs)" ${status}` });
  const base = [...start(), toolUse("t1", "cat a"), toolResult("t1"), toolUse("t2", "cat b"), started("t2", false), toolResult("t2"), toolUse("t3", "cat c"), toolResult("t3"),
    bg("t4", "Run overhead benchmark (12 runs)"), started("t4", true), toolResult("t4"), text("Measuring the prompt and tool overhead now.")];

  test("a backgrounded task stays visible and running, outside the fold", () => {
    const s = replay(base).sessions.s1;
    const tool = (id: string) => s.transcript.find((x) => x.kind === "tool" && x.toolUseId === id) as Extract<TranscriptItem, { kind: "tool" }>;
    expect(tool("t4").background).toEqual({ status: "running" });
    expect(tool("t2").background).toBeUndefined(); // a foreground command isn't a background task
    const rows = groupSteps(s.transcript);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "tool", "text"]);
    expect((rows[0] as { tools: unknown[] }).tools.length).toBe(3);
  });

  test("its notification says how it ended", () => {
    const done = replay([...base, notified("t4", "completed")]).sessions.s1.transcript.find((x) => x.kind === "tool" && x.toolUseId === "t4");
    expect(done?.kind === "tool" && done.background?.status).toBe("completed");
    const failed = replay([...base, notified("t4", "failed")]).sessions.s1.transcript.find((x) => x.kind === "tool" && x.toolUseId === "t4");
    expect(failed?.kind === "tool" && failed.background).toEqual({ status: "failed", summary: 'Background command "Run overhead benchmark (12 runs)" failed' });
  });
});
