import { shortError } from "../components/ErrorLine";
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "../state/listen";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SessionState } from "../state/types";

// A real terminal in a pane: the PTY under `termKey` is opened by `open(cols, rows)`.
export function XTermView({ termKey, open, onExit, hint }: { termKey: string; open: (cols: number, rows: number) => Promise<unknown>; onExit: () => void; hint: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
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
    const unData = listen<{ session: string; data: string }>("term-data", ({ payload }) => { if (payload.session === termKey) term.write(payload.data); });
    const unExit = listen<{ session: string }>("term-exit", ({ payload }) => { if (payload.session === termKey) onExit(); });
    const sub = term.onData((data) => void invoke("term_write", { session: termKey, data }));
    open(term.cols, term.rows).catch((e) => term.write(`\r\n${shortError(e)}\r\n`));
    const ro = new ResizeObserver(() => { fit.fit(); void invoke("term_resize", { session: termKey, cols: term.cols, rows: term.rows }).catch(() => {}); });
    ro.observe(host.current);
    return () => { ro.disconnect(); sub.dispose(); unData.then((f) => f()); unExit.then((f) => f()); term.dispose(); };
  }, [termKey, open, onExit]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="mr-dim">{hint}</span>
      <div ref={host} style={{ height: 480, padding: 8, background: "var(--mr-tile)" }} />
    </div>
  );
}

// "Take over in terminal" (decision 13): the real claude CLI for this same conversation.
// `command`: a slash command to run first, one that needs this terminal (MR-87).
export function TerminalPane({ s, command, onExit }: { s: SessionState; command?: string; onExit: () => void }) {
  return <XTermView termKey={s.id} onExit={onExit}
    open={(cols, rows) => invoke("term_open", { session: s.id, sdkSessionId: s.sdkSessionId, cwd: s.cwd, cols, rows, command: command ?? null })}
    hint={<>Real claude for this conversation. Type <b className="mr-mono">/exit</b> to hand it back to the app.</>} />;
}

// Sign a new workspace in once (decision 24): an interactive claude in that workspace's config.
export function SignInPane({ workspace, onExit }: { workspace: string; onExit: () => void }) {
  return <XTermView termKey={`login:${workspace}`} onExit={onExit}
    open={(cols, rows) => invoke("workspace_sign_in", { id: workspace, cols, rows })}
    hint={<>Type <b className="mr-mono">/login</b> and follow the browser sign-in, then <b className="mr-mono">/exit</b>.{workspace === "personal" ? " This is the official claude app; the sign-in happens in your browser." : " This workspace keeps its own memory and history."}</>} />;
}
