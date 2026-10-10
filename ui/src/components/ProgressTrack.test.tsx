import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressTrack } from ".";

// God-mode marks (wall): the track read "40% · Thinking   0s", the percent lost in the grey caption;
// a bold caption figure still wasn't enough. It is now the headline figure at the end of the bar.
test("the percent done is a headline figure beside the bar, not part of the caption", () => {
  const html = renderToStaticMarkup(<ProgressTrack segs={["done", "done", "current", "todo", "todo"]} pct={40} left="Thinking" right="0s" live fill source="01M4KXJV3S01C514MDFGJSP0HD" />);
  expect(html).toContain('aria-valuenow="40"');
  expect(html).toMatch(/<div class="mr-track-bar"><div class="mr-track-fill"[^]*?<\/div><b class="mr-track-pct">40%<\/b><\/div>/);
  expect(html).toContain('<div class="mr-track-cap"><span class="mr-ellipsis">Thinking</span>');
  expect(renderToStaticMarkup(<ProgressTrack segs={["current"]} left="Thinking" />)).not.toContain("mr-track-pct");
});
