import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressTrack } from ".";

// God-mode mark (wall): the track read "40% · Thinking   0s", with the percent lost in the grey
// caption. It now leads the caption as its own bold figure, out of the caption text.
test("the percent done is its own prominent figure, not part of the caption", () => {
  const html = renderToStaticMarkup(<ProgressTrack segs={["done", "done", "current", "todo", "todo"]} pct={40} left="Thinking" right="0s" live fill source="01M4KXJV3S01C514MDFGJSP0HD" />);
  expect(html).toContain('aria-valuenow="40"');
  expect(html).toContain('<b class="mr-track-pct">40%</b>');
  expect(html).toContain('<span class="mr-ellipsis">Thinking</span>');
  expect(renderToStaticMarkup(<ProgressTrack segs={["current"]} left="Thinking" />)).not.toContain("mr-track-pct");
});
