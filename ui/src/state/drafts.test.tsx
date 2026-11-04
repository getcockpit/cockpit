import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readDraft, useDraft, useDraftValue, writeDraft } from "./drafts";

// Typed-but-unsent text survives the box unmounting (switching sessions, tabs, workspaces).
function Box({ k }: { k: string }) {
  const [text] = useDraft(k);
  const [files] = useDraftValue<string[]>(`${k}:files`, []);
  return <textarea value={text} data-files={files.join(",")} readOnly />;
}

describe("drafts", () => {
  test("a box shows what was typed in it before it unmounted", () => {
    writeDraft("prompt:s1", "half a thought");
    writeDraft("prompt:s1:files", ["/tmp/a.png"]);
    expect(renderToStaticMarkup(<Box k="prompt:s1" />)).toContain("half a thought");
    expect(renderToStaticMarkup(<Box k="prompt:s1" />)).toContain('data-files="/tmp/a.png"');
  });

  test("each box keeps its own draft", () => {
    writeDraft("prompt:s2", "other session");
    expect(renderToStaticMarkup(<Box k="prompt:s1" />)).not.toContain("other session");
    expect(renderToStaticMarkup(<Box k="prompt:s3" />)).toContain("></textarea>");
  });

  test("an emptied draft reads back empty", () => {
    writeDraft("prompt:s1", "");
    expect(readDraft("prompt:s1", "")).toBe("");
    expect(readDraft("never-typed", "x")).toBe("x");
  });
});
