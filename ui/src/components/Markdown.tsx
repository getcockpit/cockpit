import type { ReactNode } from "react";
import { fenceCommand, inlineCommand } from "../picker/commands";
import { RunKey } from "./RunCommand";
import { FileRefChip } from "./FileChip";

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
    } else if (isRow(l)) {
      const block: string[] = [];
      for (; i < lines.length && isRow(lines[i]); i++) block.push(lines[i]);
      i--;
      out.push(<Table key={i} t={parseTable(block)} />);
    } else if (/^#{1,4} /.test(l)) {
      out.push(<strong key={i} style={{ display: "block", marginTop: 4 }}>{inline(l.replace(/^#+ /, ""))}</strong>);
    } else if (l.trim()) {
      out.push(<p key={i} style={{ margin: 0 }}>{inline(l)}</p>);
    }
  }
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{out}</div>;
}

// Tables (GFM): a header row when the second line is the |---|:--:| separator, its alignments,
// and cells split on unescaped pipes outside inline code.
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const SEPARATOR = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
type Align = "left" | "center" | "right";
export type ParsedTable = { head: string[] | null; align: Align[]; rows: string[][] };

export function splitRow(l: string): string[] {
  const cells: string[] = [];
  let cur = "", code = false;
  const s = l.trim().slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; }
    else if (c === "`") { code = !code; cur += c; }
    else if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseTable(block: string[]): ParsedTable {
  const header = block.length > 1 && SEPARATOR.test(block[1]);
  const align: Align[] = header
    ? splitRow(block[1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"))
    : [];
  const rows = block.filter((l) => !SEPARATOR.test(l)).map(splitRow);
  return { head: header ? rows[0] : null, align, rows: header ? rows.slice(1) : rows };
}

function Table({ t }: { t: ParsedTable }) {
  const cols = Math.max(t.head?.length ?? 0, ...t.rows.map((r) => r.length));
  const cell = (r: string[], k: number) => r[k] ?? "";
  return (
    <div data-mr="MarkdownTable" style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        {t.head && (
          <thead><tr>{Array.from({ length: cols }, (_, k) => <th key={k} className="mr-dim" style={{ textAlign: t.align[k] ?? "left", fontWeight: 600, fontSize: 12, padding: "4px 10px 6px 0", verticalAlign: "bottom" }}>{inline(cell(t.head!, k))}</th>)}</tr></thead>
        )}
        <tbody>
          {t.rows.map((r, j) => (
            <tr key={j} style={{ borderTop: t.head || j > 0 ? "2px solid var(--mr-well)" : undefined }}>
              {Array.from({ length: cols }, (_, k) => <td key={k} style={{ textAlign: t.align[k] ?? "left", padding: "6px 10px 6px 0", verticalAlign: "top" }}>{inline(cell(r, k))}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function inline(t: string): ReactNode[] {
  return t.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, i, parts) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.length > 2 && part.startsWith("*") && part.endsWith("*") ? <em key={i}>{part.slice(1, -1)}</em>
    : part.startsWith("`") && part.endsWith("`") ? <Code key={i} code={part.slice(1, -1)} before={parts.slice(0, i).join("")} />
    : part,
  );
}

// Inline code; a command Claude tells you to run gets a Run button after it (MR-85), and a file
// that exists becomes a chip that shows it in Finder (MR-112).
function Code({ code, before }: { code: string; before: string }) {
  const cmd = inlineCommand(code, before);
  const plain = <code className="mr-mono" style={{ background: "var(--mr-well)", padding: "0 4px" }}>{code}</code>;
  return <>{cmd ? plain : <FileRefChip text={code} fallback={plain} />}{cmd && <RunKey command={cmd} compact />}</>;
}
