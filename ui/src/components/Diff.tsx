// Snippet card code: only the lines that matter, added and removed lines tinted.
export function Diff({ code }: { code: string }) {
  return (
    <div className="mr-mono" style={{ fontSize: 12, background: "var(--mr-well)", overflowX: "auto" }}>
      {code.split("\n").map((l, i) => (
        <div key={i} style={{ padding: "1px 12px", whiteSpace: "pre", background: l.startsWith("+") ? "rgba(30,122,76,.14)" : l.startsWith("-") ? "rgba(198,40,40,.12)" : "transparent" }}>{l || " "}</div>
      ))}
    </div>
  );
}
