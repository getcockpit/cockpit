import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Key } from ".";
import { shortError } from "./ErrorLine";
import { api } from "../state/store";
import type { AppState } from "../state/types";

// A self-build that finished in the background (decision 23) offers to run it right away, on
// every screen, so closing the Builds dialog doesn't lose it. Relaunching keeps the sessions.
export function BuildReadyBanner({ all }: { all: AppState }) {
  const [error, setError] = useState("");
  const b = all.selfbuild;
  if (!b || b.phase !== "ready") return null;
  const relaunch = () => { setError(""); void invoke("selfbuild_relaunch", { buildId: b.id }).catch((e) => setError(shortError(e))); };
  return (
    <div data-mr="BuildReadyBanner" data-mr-source={b.id} style={{ display: "flex", flexDirection: "column", background: "var(--mr-band)", boxShadow: "inset 4px 0 0 var(--mr-done)" }}>
      <div className="mr-row" style={{ gap: 12, padding: "6px 16px", minHeight: 38 }}>
        <strong style={{ color: "var(--mr-done)" }}>✓ Build ready</strong>
        <span className="mr-ellipsis mr-grow mr-ink2">{[b.branch, b.sha].filter(Boolean).join(" · ")} · relaunching keeps your sessions; a failed start falls back by itself</span>
        <Key tone="primary" onClick={relaunch}>Relaunch into it</Key>
        <Key onClick={() => void api.log("ui.build_dismissed", { build_id: b.id })}>Later</Key>
      </div>
      {error && <span style={{ color: "var(--mr-error)", padding: "0 16px 6px" }}>{error}</span>}
    </div>
  );
}
