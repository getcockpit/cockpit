import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AddressView, flowChat, SnippetPager } from "./Flows";
import { replay } from "../state/reduce";
import { flowWaiting } from "../picker/pick";
import type { MrEvent, TranscriptItem } from "../state/types";

// MR-113: every snippet is a stop you can open at any point, not just the next one.
test("the pager offers every snippet, marks where Claude is and which one is shown", () => {
  const html = renderToStaticMarkup(<SnippetPager total={4} reached={[1, 2, 3]} shown={1} current={3} source="R" onGo={() => {}} />);
  expect(html.match(/<button/g)).toHaveLength(4);
  expect(html).toMatch(/aria-current="true"[^>]*title="Look back at this snippet"[^>]*>1</);
  expect(html).toMatch(/title="Claude is here"[^>]*>3 ·</);
  expect(html).toMatch(/title="Ask Claude to jump here"[^>]*>4</);
});

// Asking for the next snippet shows at once which one is on its way, before Claude draws it.
test("the pager marks the snippet Claude was asked to open", () => {
  const html = renderToStaticMarkup(<SnippetPager total={4} reached={[1, 2]} shown={2} current={2} asked={3} source="R" onGo={() => {}} />);
  expect(html).toMatch(/title="Claude is opening this one"[^>]*>3 …</);
});

// Questions typed during a review used to vanish: the flow view replaced the transcript.
test("flow chat keeps typed questions and their answers, not the opening prompt or button replies", () => {
  const u = (id: string, text: string): TranscriptItem => ({ kind: "user", id, text, at: 0 });
  const t = (id: string, text: string): TranscriptItem => ({ kind: "text", id, text, at: 0 });
  const chat = flowChat([u("1", "/review https://github.com/a/b/pull/1"), t("2", "overview"), u("3", "ok"), t("4", "snippet 1"),
    u("5", "why is this lock needed?"), t("6", "Because the cache is shared."), u("7", "note f1"), t("8", "noted"), u("9", "Option 2: Fix it"), u("9b", "Thread t1 · Option A: Stream it"), u("9c", "publish and approve"), u("10", "and the retry?")]);
  expect(chat.map((x) => [x.ask.text, x.answer.map((a) => a.kind === "text" && a.text)])).toEqual([["why is this lock needed?", ["Because the cache is shared."]], ["and the retry?", []]]);
});

// MR-126: every thread is drawn up front, so you decide on all of them while Claude still reads or fixes.
const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "X", kind, payload, anchor: null, created_at: 1 });
const opts = [{ id: "A", label: "Fix it", recommended: true }, { id: "B", label: "Push back" }];
const start = [
  ev("A1", "ui.session_requested", { prompt: "/pr-address 9", kind: "address", cwd: "/w" }),
  ev("A2", "flow.address_threads", { pr: "#9", threads: [{ id: "t1", at: "a.ts:1", short: "one", state: "open" }, { id: "t2", at: "a.ts:2", short: "two", state: "open" }, { id: "t3", at: "a.ts:3", short: "three", state: "open" }] }),
  ev("A3", "flow.address_thread", { id: "t1", body: "first", options: opts }),
  ev("A4", "flow.address_thread", { id: "t2", body: "second", options: opts }),
];

test("address shows threads as they are read and opens the first undecided one", () => {
  const s = replay(start).sessions["X"];
  const html = renderToStaticMarkup(<AddressView s={s} />);
  expect(html).toContain("Claude is reading the threads · 2 of 3 ready");
  expect(html).toContain("a.ts:3 · reading…");
  expect(html).toContain("first");
});

test("after a pick the next undecided thread opens and the picked one is queued, then fixed", () => {
  let s = replay([...start, ev("A5", "ui.address_chosen", { id: "t1", option: "A" })]).sessions["X"];
  let html = renderToStaticMarkup(<AddressView s={s} />);
  expect(html).toContain("a.ts:1 · queued");
  expect(html).toContain("second");
  s = replay([...start, ev("A5", "ui.address_chosen", { id: "t1", option: "A" }), ev("A6", "flow.address_thread", { id: "t3", body: "third", options: opts }), ev("A7", "flow.address_fixing", { id: "t1" })]).sessions["X"];
  html = renderToStaticMarkup(<AddressView s={s} />);
  expect(html).toContain("Claude is fixing a.ts:1");
  expect(html).toContain("a.ts:1 · fixing now");
});

test("when every thread is handled, address offers the next steps", () => {
  const all = [...start, ev("A6", "flow.address_thread", { id: "t3", body: "third", options: opts }),
    ...["t1", "t2", "t3"].flatMap((id, i) => [ev(`B${i}`, "ui.address_chosen", { id, option: "A" }), ev(`C${i}`, "flow.address_reply", { id, text: "done", posted: true })]),
    ev("D1", "flow.address_done", { summary: "3 fixed", next: [{ label: "Push and re-request review", reply: "push" }] }),
    ev("D2", "sidecar.sdk", { message: { type: "result", is_error: false, result: "ok" } })];
  const s = replay(all).sessions["X"];
  const html = renderToStaticMarkup(<AddressView s={s} />);
  expect(html).toContain("All threads handled");
  expect(html).toContain("Push and re-request review");
  expect(flowWaiting(s)).toBe("All threads handled · next: Push and re-request review");
});
