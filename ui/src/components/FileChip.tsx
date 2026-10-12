import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fileRef, splitPath } from "../picker/paths";

// File chips (MR-112): a file Claude names in a reply shows like an attachment, and clicking it
// shows the file in Finder. The Focus transcript provides the session and its folder; outside a
// provider (docs) paths stay plain code. A chip appears only once the core says the file exists.
export const FileContext = createContext<{ session: string; cwd: string } | null>(null);

// Existence answers, per folder and path, so a re-render or a repeated path asks once. Asks made
// in the same tick go to the core as one call.
const known = new Map<string, boolean>();
const waiting = new Map<string, { cwd: string; path: string; done: ((v: boolean) => void)[] }>();
let flush: ReturnType<typeof setTimeout> | null = null;

function exists(cwd: string, path: string): Promise<boolean> {
  const key = `${cwd}\0${path}`;
  const k = known.get(key);
  if (k !== undefined) return Promise.resolve(k);
  return new Promise((done) => {
    const w = waiting.get(key);
    if (w) w.done.push(done);
    else waiting.set(key, { cwd, path, done: [done] });
    flush ??= setTimeout(ask, 0);
  });
}

function ask() {
  flush = null;
  const byCwd = new Map<string, [string, { path: string; done: ((v: boolean) => void)[] }][]>();
  for (const [key, w] of waiting) byCwd.set(w.cwd, [...(byCwd.get(w.cwd) ?? []), [key, w]]);
  waiting.clear();
  for (const [cwd, items] of byCwd) {
    invoke<boolean[]>("files_exist", { cwd, paths: items.map(([, w]) => w.path) })
      .catch(() => items.map(() => false))
      .then((res) => items.forEach(([key, w], i) => { known.set(key, !!res[i]); w.done.forEach((d) => d(!!res[i])); }));
  }
}

function reveal(session: string, cwd: string, path: string) {
  invoke("file_reveal", { session, cwd, path }).catch((e) => {
    window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Can't show it: ${String(e).split("\n")[0]}` }));
  });
}

/** A file reference as a chip that shows the file in Finder, or `fallback` when it isn't one. */
export function FileRefChip({ text, fallback }: { text: string; fallback: ReactNode }) {
  const ctx = useContext(FileContext);
  const ref = ctx ? fileRef(text) : null;
  const key = ctx && ref ? `${ctx.cwd}\0${ref.path}` : "";
  const [ok, setOk] = useState(() => (key ? known.get(key) === true : false));
  useEffect(() => {
    if (!ctx || !ref) return;
    let live = true;
    void exists(ctx.cwd, ref.path).then((v) => live && setOk(v));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctx || !ref || !ok) return <>{fallback}</>;
  const { dir, name } = splitPath(ref.path);
  return (
    <button type="button" data-mr="FileChip" data-mr-source={ref.path} title={`Show in Finder\n${ref.path}`} onClick={() => reveal(ctx.session, ctx.cwd, ref.path)}
      style={{ display: "inline-flex", alignItems: "baseline", gap: 5, maxWidth: "100%", minHeight: 0, padding: "0 6px", border: 0, borderRadius: 2, background: "var(--mr-well)", color: "var(--mr-ink)", font: "inherit", fontSize: "0.92em", cursor: "pointer", verticalAlign: "baseline", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      <FileIcon folder={ref.path.endsWith("/")} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {dir && <span className="mr-dim">{dir}</span>}<span style={{ fontWeight: 600 }}>{name}</span>{ref.line != null && <span className="mr-dim">:{ref.line}</span>}
      </span>
    </button>
  );
}

function FileIcon({ folder }: { folder: boolean }) {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" style={{ flex: "none", alignSelf: "center", color: "var(--mr-ink-3)" }}>
      {folder
        ? <path d="M0.5 2.5h3.5l1 1h4.5v7h-9z" fill="none" stroke="currentColor" />
        : <path d="M0.5 0.5h6l3 3v8h-9z M6.5 0.5v3h3" fill="none" stroke="currentColor" />}
    </svg>
  );
}
