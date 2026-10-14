import type { CommandRow } from "../state/types";

// The / menu (MR-87). `below`: it opens under the box (a box near the top of the window).: the session's commands and skills, filtered as you type. ↑↓ move, Tab or ↵ picks.
export function SlashMenu({ rows, active, onPick, onHover, source, below }: { rows: CommandRow[]; active: number; onPick: (r: CommandRow) => void; onHover: (i: number) => void; source: string; below?: boolean }) {
  if (!rows.length) return null;
  return (
    <div role="listbox" aria-label="Commands and skills" data-mr="SlashMenu" data-mr-source={source} data-mr-menu
      style={{ position: "absolute", left: 0, right: 0, ...(below ? { top: "calc(100% + 4px)" } : { bottom: "calc(100% + 4px)" }), zIndex: 6, background: "var(--mr-band)", display: "flex", flexDirection: "column", maxHeight: 320, overflowY: "auto" }}>
      {rows.map((r, i) => (
        <button key={r.name} type="button" role="option" aria-selected={i === active} data-mr="SlashRow" data-mr-source={r.name}
          onMouseDown={(e) => { e.preventDefault(); onPick(r); }} onMouseEnter={() => onHover(i)}
          style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "6px 10px", border: 0, font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--mr-ink)", background: i === active ? "var(--mr-well)" : "transparent", boxShadow: i === active ? "inset 3px 0 0 var(--mr-selected)" : "none" }}>
          <span className="mr-mono" style={{ whiteSpace: "nowrap" }}>/{r.name}{r.hint && <span className="mr-dim"> {r.hint}</span>}</span>
          <span className="mr-dim mr-ellipsis" style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{r.description}</span>
          <span className="mr-mono mr-dim" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{r.skill ? "skill" : r.terminal ? "terminal" : r.name === "mcp" || r.name === "model" ? "panel" : "command"}</span>
        </button>
      ))}
    </div>
  );
}

// The @ menu (MR-108): files and folders in the session's folder, filtered as you type. Same keys as the / menu.
export function MentionMenu({ paths, active, onPick, onHover, source, below }: { paths: string[]; active: number; onPick: (p: string) => void; onHover: (i: number) => void; source: string; below?: boolean }) {
  if (!paths.length) return null;
  return (
    <div role="listbox" aria-label="Files and folders" data-mr="MentionMenu" data-mr-source={source} data-mr-menu
      style={{ position: "absolute", left: 0, right: 0, ...(below ? { top: "calc(100% + 4px)" } : { bottom: "calc(100% + 4px)" }), zIndex: 6, background: "var(--mr-band)", display: "flex", flexDirection: "column", maxHeight: 320, overflowY: "auto" }}>
      {paths.map((p, i) => {
        const dir = p.endsWith("/"), cut = p.replace(/\/$/, "").lastIndexOf("/") + 1;
        return (
          <button key={p} type="button" role="option" aria-selected={i === active} data-mr="MentionRow" data-mr-source={p}
            onMouseDown={(e) => { e.preventDefault(); onPick(p); }} onMouseEnter={() => onHover(i)}
            style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "6px 10px", border: 0, font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--mr-ink)", background: i === active ? "var(--mr-well)" : "transparent", boxShadow: i === active ? "inset 3px 0 0 var(--mr-selected)" : "none" }}>
            <span className="mr-mono mr-ellipsis" style={{ flex: 1, minWidth: 0 }}><span className="mr-dim">@{p.slice(0, cut)}</span>{p.slice(cut)}</span>
            <span className="mr-mono mr-dim" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{dir ? "folder" : "file"}</span>
          </button>
        );
      })}
    </div>
  );
}
