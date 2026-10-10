// Wall | Timeline (decision 29, MR-32): two views of the same sessions, now and over time. T switches.
export function ViewTabs({ on, onSwitch }: { on: "wall" | "timeline"; onSwitch: (to: "wall" | "timeline") => void }) {
  const tab = (id: "wall" | "timeline", label: string) => (
    <button type="button" role="tab" aria-selected={on === id} data-mr="ViewTab" data-mr-source={id} onClick={() => on !== id && onSwitch(id)}
      style={{ padding: "4px 10px", border: 0, font: "inherit", fontSize: 15, fontWeight: 700, cursor: on === id ? "default" : "pointer", background: on === id ? "var(--mr-tile)" : "transparent", color: on === id ? "var(--mr-ink)" : "var(--mr-ink-3)" }}>{label}</button>
  );
  return (
    <span role="tablist" aria-label="View" className="mr-row" style={{ gap: 2, marginRight: 10 }} title="T switches">
      {tab("wall", "Wall")}{tab("timeline", "Timeline")}<kbd className="mr-mono mr-dim" style={{ fontSize: 11, marginLeft: 4 }}>T</kbd>
    </span>
  );
}
