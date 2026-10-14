import { useState } from "react";
import type { CommandRow } from "../state/types";
import { markPath, segments } from "../picker/compose";
import { FileRefChip } from "./FileChip";

// Your sent message as the box marked it: @files as file chips (click shows it in Finder), the
// /command or skill as a tag. A long message (a big paste) shows its first lines, then all of it on a click.
const FOLD = 8;

export function UserText({ text, commands }: { text: string; commands: CommandRow[] }) {
  const lines = text.split("\n");
  const [all, setAll] = useState(lines.length <= FOLD + 2);
  const shown = all ? text : lines.slice(0, FOLD).join("\n");
  const known = (n: string) => !commands.length || commands.some((c) => c.name === n || c.aliases.includes(n));
  return (
    <span data-mr="UserText" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {segments(shown, known).map((m, i) => m.kind === "file"
        ? <FileRefChip key={i} text={markPath(m.text)} fallback={<span className="mr-mono" style={{ background: "color-mix(in srgb, var(--mr-selected) 18%, transparent)", padding: "0 3px", borderRadius: 2 }}>{m.text}</span>} />
        : m.kind === "command"
          ? <span key={i} className="mr-mono" data-mr="CommandTag" data-mr-source={m.text} style={{ padding: "1px 5px", background: "var(--mr-ink)", color: "var(--mr-tile)", borderRadius: 2 }}>{m.text}</span>
          : <span key={i}>{m.text}</span>)}
      {!all && (
        <button type="button" onClick={() => setAll(true)} className="mr-dim"
          style={{ display: "block", marginTop: 4, padding: 0, minHeight: 0, border: 0, background: "transparent", font: "inherit", fontSize: 13, cursor: "pointer", textDecoration: "underline" }}>
          Show all {lines.length} lines
        </button>
      )}
    </span>
  );
}
