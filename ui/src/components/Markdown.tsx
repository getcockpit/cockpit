import type { ReactNode } from "react";
import { fenceCommand, inlineCommand } from "../picker/commands";
import { RunKey } from "./RunCommand";

// A deliberately small Markdown renderer for doc bodies: headings, lists, code fences, tables,
// bold and inline code. Text is never injected as HTML.
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      const cmd = fenceCommand(l.slice(3), code);
      out.push(
        <div key={i} style={{ position: "relative" }}>
          <pre className="mr-code" style={{ fontSize: 12, margin: 0 }}>{code.join("\n")}</pre>
          {cmd && <span style={{ position: "absolute", top: 4, right: 4 }}><RunKey command={cmd} /></span>}
        </div>,
      );
    } else if (/^\s*[-*] /.test(l)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*[-*] /.test(lines[i]); i++) items.push(lines[i].replace(/^\s*[-*] /, ""));
      i--;
      out.push(<ul key={i} style={{ margin: 0, paddingLeft: 18 }}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>);
    } else if (/^\s*\d+[.)] /.test(l)) {
      // Numbered lists (MR-56): Claude's steps and todos.
      const items: string[] = [];
      for (; i < lines.length && /^\s*\d+[.)] /.test(lines[i]); i++) items.push(lines[i].replace(/^\s*\d+[.)] /, ""));
      i--;
      out.push(<ol key={i} style={{ margin: 0, paddingLeft: 22 }}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>);
    } else if (/^\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) if (!/^\|[\s:-|]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
      i--;
      out.push(
        <div key={i} style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <tbody>{rows.map((r, j) => <tr key={j} style={{ background: j === 0 ? "var(--mr-well)" : "transparent" }}>{r.map((c, k) => <td key={k} style={{ padding: "4px 8px", fontWeight: j === 0 ? 700 : 400 }}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
    } else if (/^#{1,4} /.test(l)) {
      out.push(<strong key={i} style={{ display: "block", marginTop: 4 }}>{inline(l.replace(/^#+ /, ""))}</strong>);
    } else if (l.trim()) {
      out.push(<p key={i} style={{ margin: 0 }}>{inline(l)}</p>);
    }
  }
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{out}</div>;
}

export function inline(t: string): ReactNode[] {
  return t.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, i, parts) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.length > 2 && part.startsWith("*") && part.endsWith("*") ? <em key={i}>{part.slice(1, -1)}</em>
    : part.startsWith("`") && part.endsWith("`") ? <Code key={i} code={part.slice(1, -1)} before={parts[i - 1] ?? ""} />
    : part,
  );
}

// Inline code; a command Claude tells you to run gets a Run button after it (MR-85).
function Code({ code, before }: { code: string; before: string }) {
  const cmd = inlineCommand(code, before);
  return <><code className="mr-mono" style={{ background: "var(--mr-well)", padding: "0 4px" }}>{code}</code>{cmd && <RunKey command={cmd} compact />}</>;
}
