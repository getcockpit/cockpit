import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { flowChat, SnippetPager } from "./Flows";
import type { TranscriptItem } from "../state/types";

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
    u("5", "why is this lock needed?"), t("6", "Because the cache is shared."), u("7", "note f1"), t("8", "noted"), u("9", "Option 2: Fix it"), u("10", "and the retry?")]);
  expect(chat.map((x) => [x.ask.text, x.answer.map((a) => a.kind === "text" && a.text)])).toEqual([["why is this lock needed?", ["Because the cache is shared."]], ["and the retry?", []]]);
});
