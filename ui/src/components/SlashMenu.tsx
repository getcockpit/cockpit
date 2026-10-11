import type { CommandRow } from "../state/types";

// The / menu (MR-87): the session's commands and skills, filtered as you type. ↑↓ move, Tab or ↵ picks.
export function SlashMenu({ rows, active, onPick, onHover, source }: { rows: CommandRow[]; active: number; onPick: (r: CommandRow) => void; onHover: (i: number) => void; source: string }) {
  if (!rows.length) return null;
  return (
    <div role="listbox" aria-label="Commands and skills" data-mr="SlashMenu" data-mr-source={source} data-mr-menu
      style={{ position: "absolute", left: 0, right: 0, bottom: "calc(100% + 4px)", zIndex: 6, background: "var(--mr-band)", display: "flex", flexDirection: "column", maxHeight: 320, overflowY: "auto" }}>
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
