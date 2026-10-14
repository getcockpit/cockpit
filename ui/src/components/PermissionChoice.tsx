import { useEffect } from "react";
import { Key } from ".";
import { keyOf } from "./keys";
import { api } from "../state/store";
import type { PermissionMode } from "../state/types";

// How sessions ask before using tools (decision I106). Asked once: in the intro, or on the wall for
// anyone who finished the intro before it asked. Settings → Sessions changes it later.

export const PERMISSION_MODES: { id: PermissionMode; title: string; what: string; short: string }[] = [
  { id: "auto", title: "Only when it's risky", short: "Risky only", what: "Claude Code's safety check approves routine reads, edits and commands, and asks you about anything destructive or outside the project." },
  { id: "acceptEdits", title: "Edits go through, commands ask", short: "Commands", what: "File edits happen without asking. Every shell command and web call waits for you." },
  { id: "default", title: "Ask me every time", short: "Everything", what: "Every tool call waits for your Allow. The most control, and the most cards." },
];

export function PermissionOptions({ value, onPick }: { value: PermissionMode | null; onPick: (m: PermissionMode) => void }) {
  return (
    <div role="radiogroup" aria-label="When sessions ask for permission" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "var(--mr-gap)" }}>
      {PERMISSION_MODES.map((m, i) => (
        <button key={m.id} type="button" role="radio" aria-checked={value === m.id} data-mr="PermissionOption" data-mr-source={m.id} onClick={() => onPick(m.id)}
          style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16, border: 0, outline: value === m.id ? "2px solid var(--mr-selected)" : undefined, outlineOffset: -2, background: "var(--mr-tile)", textAlign: "left", font: "inherit", color: "var(--mr-ink)", cursor: "pointer", minHeight: 130 }}>
          <span className="mr-row" style={{ justifyContent: "space-between" }}>
            <strong style={{ fontSize: 16 }}>{m.title}{value === m.id ? " ✓" : ""}</strong>
            {i === 0 && <span className="mr-mono mr-dim" style={{ fontSize: 11 }}>RECOMMENDED</span>}
          </span>
          <span className="mr-dim">{m.what}</span>
        </button>
      ))}
    </div>
  );
}

// The one-time ask for people who were onboarded before the intro had this step.
export function PermissionPrompt({ onDone }: { onDone: () => void }) {
  const pick = (m: PermissionMode) => { void api.setPermissionMode(m); onDone(); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (keyOf(e) === "Enter") { e.preventDefault(); pick("auto"); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <div role="dialog" className="mr-scrim" aria-label="How often should sessions ask?" data-mr="PermissionPrompt"
      style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", padding: 24, background: "rgba(21,24,27,.35)", zIndex: 30 }}>
      <div className="mr-sheet" style={{ width: "100%", maxWidth: 880, background: "var(--mr-base)", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <strong style={{ fontSize: 18 }}>How often should sessions ask for permission?</strong>
        <span className="mr-dim">Pick once; change it any time in Settings → Sessions. It applies to running sessions right away.</span>
        <PermissionOptions value={null} onPick={pick} />
        <div className="mr-row"><span className="mr-grow" /><Key k="↵" tone="primary" onClick={() => pick("auto")}>Only when it's risky</Key></div>
      </div>
    </div>
  );
}
