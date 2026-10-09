import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SessionState } from "../state/types";

// "Take over in terminal" (decision 13): the real claude CLI for this same conversation, in a pane.
// Exiting claude hands the session back to the app.
export function TerminalPane({ s, onExit }: { s: SessionState; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !s.sdkSessionId) return;
    const css = getComputedStyle(document.documentElement);
    const term = new XTerm({
      fontFamily: css.getPropertyValue("--mr-mono"), fontSize: 13, cursorBlink: true,
      theme: { background: css.getPropertyValue("--mr-tile").trim(), foreground: css.getPropertyValue("--mr-ink").trim(), cursor: css.getPropertyValue("--mr-ink").trim(), selectionBackground: css.getPropertyValue("--mr-well").trim() },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    term.focus();
    const unData = listen<{ session: string; data: string }>("term-data", ({ payload }) => { if (payload.session === s.id) term.write(payload.data); });
    const unExit = listen<{ session: string }>("term-exit", ({ payload }) => { if (payload.session === s.id) onExit(); });
    const sub = term.onData((data) => void invoke("term_write", { session: s.id, data }));
    void invoke("term_open", { session: s.id, sdkSessionId: s.sdkSessionId, cwd: s.cwd, cols: term.cols, rows: term.rows });
    const ro = new ResizeObserver(() => { fit.fit(); void invoke("term_resize", { session: s.id, cols: term.cols, rows: term.rows }).catch(() => {}); });
    ro.observe(host.current);
    return () => { ro.disconnect(); sub.dispose(); unData.then((f) => f()); unExit.then((f) => f()); term.dispose(); };
  }, [s.id, s.sdkSessionId, s.cwd, onExit]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="mr-dim">Real claude for this conversation. Type <b className="mr-mono">/exit</b> to hand it back to the app.</span>
      <div ref={host} style={{ height: 480, padding: 8, background: "var(--mr-tile)" }} />
    </div>
  );
}
