import { Key } from ".";
import { api } from "../state/store";

// The one-line installer for this OS: PowerShell on Windows, the shell script elsewhere.
export function installCommand(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  return /Windows/i.test(ua) ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";
}

// Claude Code isn't installed (the sidecar is up but found no `claude`). Check again re-detects
// without a restart: the sidecar looks for claude again on every limits request.
export function NoClaude({ compact }: { compact?: boolean }) {
  const how = <>In a terminal run <span className="mr-mono" style={{ userSelect: "text" }}>{installCommand()}</span>, then check again.</>;
  if (compact) return <span data-mr="NoClaude" className="mr-row" style={{ gap: 10, flexWrap: "wrap" }}>Not found. {how}<Key onClick={() => void api.refreshLimits()}>Check again</Key></span>;
  return (
    <section data-mr="NoClaude" aria-label="Claude Code isn't installed" className="mr-row" style={{ gap: 14, padding: "12px 16px", background: "var(--mr-tile)", borderLeft: "4px solid var(--mr-needs)", flexWrap: "wrap" }}>
      <span style={{ color: "var(--mr-needs-ink)" }}>◆</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <strong>Claude Code isn't installed</strong>
        <span className="mr-dim">Cockpit drives your own <span className="mr-mono">claude</span>. {how}</span>
      </span>
      <span className="mr-grow" />
      <Key tone="needs" onClick={() => void api.refreshLimits()}>Check again</Key>
    </section>
  );
}
