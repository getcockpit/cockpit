import { useEffect, useState } from "react";
import { Key } from ".";
import { keyOf } from "./keys";
import { api } from "../state/store";
import type { PermissionMode } from "../state/types";

// How sessions ask before using tools (decision I106). Asked once: in the intro, or on the wall for
// anyone who finished the intro before it asked. Settings → Sessions changes it later.
// Never ask (I107) is Cockpit's own: everything below high risk goes through, and only after you
// accept the disclaimer.

export const PERMISSION_MODES: { id: PermissionMode; title: string; what: string; short: string }[] = [
  { id: "auto", title: "Only when it's risky", short: "Risky only", what: "Claude Code's safety check approves routine reads, edits and commands, and asks you about anything destructive or outside the project." },
  { id: "acceptEdits", title: "Edits go through, commands ask", short: "Commands", what: "File edits happen without asking. Every shell command and web call waits for you." },
  { id: "default", title: "Ask me every time", short: "Everything", what: "Every tool call waits for your Allow. The most control, and the most cards." },
  { id: "never", title: "Never ask", short: "High risk only", what: "Everything goes through except high-risk actions, which still ask. Risky: anything a session does is on you." },
];

// Picking a mode: Never ask goes through the disclaimer first. Render `dialog` where the picker is.
export function usePermissionPick(onPicked?: (m: PermissionMode) => void) {
  const [confirming, setConfirming] = useState(false);
  const set = (m: PermissionMode) => { void api.setPermissionMode(m); onPicked?.(m); };
  const pick = (m: PermissionMode) => (m === "never" ? setConfirming(true) : set(m));
  const dialog = confirming && <NeverAskDisclaimer onCancel={() => setConfirming(false)} onAccept={() => { setConfirming(false); set("never"); }} />;
  return { pick, dialog };
}

export function PermissionOptions({ value, onPick }: { value: PermissionMode | null; onPick: (m: PermissionMode) => void }) {
  return (
    <div role="radiogroup" aria-label="When sessions ask for permission" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "var(--mr-gap)" }}>
      {PERMISSION_MODES.map((m, i) => (
        <button key={m.id} type="button" role="radio" aria-checked={value === m.id} data-mr="PermissionOption" data-mr-source={m.id} onClick={() => onPick(m.id)}
          style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16, border: 0, outline: value === m.id ? "2px solid var(--mr-selected)" : undefined, outlineOffset: -2, background: "var(--mr-tile)", boxShadow: m.id === "never" ? "inset 4px 0 0 var(--mr-error)" : undefined, textAlign: "left", font: "inherit", color: "var(--mr-ink)", cursor: "pointer", minHeight: 130 }}>
          <span className="mr-row" style={{ justifyContent: "space-between" }}>
            <strong style={{ fontSize: 16 }}>{m.title}{value === m.id ? " ✓" : ""}</strong>
            {i === 0 && <span className="mr-mono mr-dim" style={{ fontSize: 11 }}>RECOMMENDED</span>}
            {m.id === "never" && <span className="mr-mono" style={{ fontSize: 11, color: "var(--mr-error)" }}>RISKY</span>}
          </span>
          <span className="mr-dim" style={m.id === "never" ? { color: "var(--mr-error)" } : undefined}>{m.what}</span>
        </button>
      ))}
    </div>
  );
}

// The disclaimer (I107): you accept it with a tick before Never ask turns on. Keep asking is the default.
export function NeverAskDisclaimer({ onCancel, onAccept }: { onCancel: () => void; onAccept: () => void }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (keyOf(e) === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });
  return (
    <div role="alertdialog" className="mr-scrim" aria-label="Never ask: this is on you" data-mr="NeverAskDisclaimer"
      style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", padding: 24, background: "rgba(21,24,27,.6)", zIndex: 60 }}>
      <div className="mr-sheet" style={{ width: "100%", maxWidth: 760, background: "var(--mr-tile)", boxShadow: "inset 0 6px 0 var(--mr-error)", padding: "28px 28px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="mr-mono" style={{ color: "var(--mr-error)", fontSize: 12, letterSpacing: ".08em" }}>⚠ VERY RISKY</div>
        <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.1 }}>Never ask: this is on you.</h1>
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.5 }}>
          Sessions will run shell commands, install packages, push branches, call MCP tools and reach the web <b>without asking you</b>. <b>Anything they do is your responsibility</b>: lost files, broken branches, leaked data, bills from cloud tools.
        </p>
        <div style={{ padding: 14, background: "var(--mr-well)", display: "flex", flexDirection: "column", gap: 6 }}>
          <strong>Still asks you about high-risk actions:</strong>
          <span className="mr-dim">rm -rf, force-push, sudo, piping a download into a shell, DROP TABLE, kubectl and terraform apply or destroy, migrations; edits outside the project; and Claude's own questions and plans.</span>
        </div>
        <p style={{ margin: 0, color: "var(--mr-error)", lineHeight: 1.5 }}>
          The risk check matches known patterns. It can miss a dangerous command it doesn't recognise, and that command will run. Use Never ask only in folders you can afford to lose, with your work committed and pushed.
        </p>
        <label className="mr-row" style={{ gap: 10, cursor: "pointer", fontWeight: 600 }}>
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} data-mr="NeverAskAccept" />
          I understand the risk, and that anything a session does is on me.
        </label>
        <div className="mr-row" style={{ gap: 8 }}>
          <span className="mr-grow" />
          <Key onClick={() => ok && onAccept()} disabled={!ok}>Turn on Never ask</Key>
          <Key k="esc" tone="primary" onClick={onCancel}>Keep asking</Key>
        </div>
      </div>
    </div>
  );
}

// The one-time ask for people who were onboarded before the intro had this step.
export function PermissionPrompt({ onDone }: { onDone: () => void }) {
  const { pick, dialog } = usePermissionPick(() => onDone());
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (!dialog && keyOf(e) === "Enter") { e.preventDefault(); pick("auto"); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <div role="dialog" className="mr-scrim" aria-label="How often should sessions ask?" data-mr="PermissionPrompt"
      style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", padding: 24, background: "rgba(21,24,27,.35)", zIndex: 30 }}>
      <div className="mr-sheet" style={{ width: "100%", maxWidth: 1080, background: "var(--mr-base)", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <strong style={{ fontSize: 18 }}>How often should sessions ask for permission?</strong>
        <span className="mr-dim">Pick once; change it any time in Settings → Sessions. It applies to running sessions right away.</span>
        <PermissionOptions value={null} onPick={pick} />
        <div className="mr-row"><span className="mr-grow" /><Key k="↵" tone="primary" onClick={() => pick("auto")}>Only when it's risky</Key></div>
      </div>
      {dialog}
    </div>
  );
}
