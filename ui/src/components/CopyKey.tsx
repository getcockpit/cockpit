import { useEffect, useState, type CSSProperties } from "react";

// A quick Copy button for a rendered text block: puts its source text on the clipboard and says
// "Copied" for a moment. Sits in a `.mr-copyable` block and shows on hover or keyboard focus.
export function CopyKey({ text, style }: { text: string; style?: CSSProperties }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1200);
    return () => clearTimeout(t);
  }, [state]);
  const copy = () => navigator.clipboard.writeText(text).then(() => setState("done"), () => setState("failed"));
  return (
    <button type="button" className="mr-key mr-copy" data-mr="CopyText" data-state={state} title="Copy this text" onClick={copy}
      style={{ minHeight: 22, padding: "0 8px", fontSize: 11, ...style }}>
      {state === "done" ? "✓ Copied" : state === "failed" ? "Can't copy" : "Copy"}
    </button>
  );
}
