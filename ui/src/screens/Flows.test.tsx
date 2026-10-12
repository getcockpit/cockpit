import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SnippetPager } from "./Flows";

// MR-113: every snippet is a stop you can open at any point, not just the next one.
test("the pager offers every snippet, marks where Claude is and which one is shown", () => {
  const html = renderToStaticMarkup(<SnippetPager total={4} reached={[1, 2, 3]} shown={1} current={3} source="R" onGo={() => {}} />);
  expect(html.match(/<button/g)).toHaveLength(4);
  expect(html).toMatch(/aria-current="true"[^>]*title="Look back at this snippet"[^>]*>1</);
  expect(html).toMatch(/title="Claude is here"[^>]*>3 ·</);
  expect(html).toMatch(/title="Ask Claude to jump here"[^>]*>4</);
});
