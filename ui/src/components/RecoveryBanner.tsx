import { useState } from "react";
import { Key } from ".";
import { api } from "../state/store";
import type { AppState } from "../state/types";

// After a crash at start the dev loop relaunches the last stable build (MR-70). Say so plainly,
// show the crash, and make reporting it one click (a fix session on the app, like any bug report).
export function RecoveryBanner({ all }: { all: AppState }) {
  const [open, setOpen] = useState(false);
  const r = all.recovered;
  if (!r) return null;
  return (
    <div role="alert" data-mr="RecoveryBanner" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 24px", background: "var(--mr-tile)", boxShadow: "inset 4px 0 0 var(--mr-error)" }}>
      <div className="mr-row" style={{ gap: 10, flexWrap: "wrap" }}>
        <strong style={{ color: "var(--mr-error)" }}>The newest build crashed at start.</strong>
        <span className="mr-ink2">You're on the last stable build, and your sessions were resumed. The crash is logged in src-tauri/target/crashes.log.</span>
        <span className="mr-grow" />
        <button type="button" className="mr-link" onClick={() => setOpen((x) => !x)}>{open ? "Hide the crash" : "Show the crash"}</button>
        <Key tone="primary" onClick={() => api.report((document.querySelector('[data-mr="RecoveryBanner"]') as HTMLElement | null) ?? undefined)}>Report it</Key>
        <Key onClick={() => void api.log("ui.recovery_dismissed", {})}>Dismiss</Key>
      </div>
      {open && <pre className="mr-code" style={{ margin: 0, fontSize: 11, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap" }}>{r.log || "No log captured."}</pre>}
    </div>
  );
}
