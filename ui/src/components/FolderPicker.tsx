import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { keyOf } from "./keys";
import { resolveTyped } from "./typedPath";

// Work-folder picker (MR-36): one button showing where the session will run. Opens a list of the
// folders you actually work in (this app's sessions + Claude Code's history), filter by typing,
// paste a path, or browse with the macOS folder dialog.

type Folder = { path: string; name: string; repo: boolean; at: number };

/** The work folder. Opens on the workspace's own folder (`preferred`: pinned, else where its last
 *  session ran, MR-65), else the last one picked anywhere; a fresh install defaults to your most
 *  recent folder instead of your home directory (F6). */
export function useWorkFolder(preferred: string | null = null): [string, (p: string) => void] {
  const [cwd, setCwd] = useState(() => { if (preferred) return preferred; try { return localStorage.getItem("mr.cwd") ?? ""; } catch { return ""; } });
  useEffect(() => { if (preferred) setCwd(preferred); }, [preferred]);
  useEffect(() => {
    if (cwd && cwd !== "~/") return;
    invoke<Folder[]>("recent_folders").then((f) => setCwd(f[0]?.path ?? "~/")).catch(() => setCwd("~/"));
  }, []);
  const set = (p: string) => { setCwd(p); try { localStorage.setItem("mr.cwd", p); } catch { /* convenience only */ } };
  return [cwd || "~/", set];
}

/** Pins the shown folder as this workspace's default, or unpins it (MR-65). */
export function PinFolder({ workspace, folder, pinned }: { workspace: string; folder: string; pinned: string | null }) {
  const [error, setError] = useState("");
  const on = !!pinned && pinned === folder;
  const toggle = () => { setError(""); invoke("workspace_set_folder", { id: workspace, folder: on ? null : folder }).catch((e) => setError(String(e).split("\n")[0])); };
  return (
    <button type="button" data-mr="PinFolder" data-mr-source={workspace} onClick={toggle} aria-pressed={on}
      title={error || (on ? "This workspace always starts here. Click to unpin (it will follow your last folder)" : "Always start this workspace's sessions in this folder")}
      style={{ border: 0, font: "inherit", fontSize: 12, padding: "0 10px", cursor: "pointer", whiteSpace: "nowrap", background: on ? "var(--mr-selected)" : "var(--mr-well)", color: error ? "var(--mr-error)" : on ? "var(--mr-tile)" : "var(--mr-ink)" }}>
      {error ? "Can't pin" : on ? "Pinned" : "Pin"}
    </button>
  );
}

const tilde = (p: string, home: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);

export function FolderPicker({ value, onChange, extra }: { value: string; onChange: (p: string) => void; extra: string[] }) {
  const [openList, setOpenList] = useState(false);
  const [found, setFound] = useState<Folder[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [realHome, setRealHome] = useState("");
  const home = useMemo(() => realHome || (found.find((f) => f.path.startsWith("/Users/"))?.path.split("/").slice(0, 3).join("/") ?? ""), [realHome, found]);

  useEffect(() => { invoke<Folder[]>("recent_folders").then(setFound).catch(() => {}); }, []);
  useEffect(() => { homeDir().then((h) => setRealHome(h.replace(/\/+$/, ""))).catch(() => {}); }, []);
  useEffect(() => {
    if (!openList) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpenList(false); };
    window.addEventListener("mousedown", away, true);
    return () => window.removeEventListener("mousedown", away, true);
  }, [openList]);

  const all = useMemo(() => {
    const seen = new Set<string>();
    const fromApp = extra.filter(Boolean).map((p) => ({ path: p, name: p.split("/").filter(Boolean).at(-1) ?? p, repo: true, at: 0 }));
    return [...fromApp, ...found].filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
  }, [found, extra]);
  const typedPath = resolveTyped(q, value, home);
  const list = all.filter((f) => !q.trim() || typedPath || `${f.name} ${f.path}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 9);
  const rows: { label: string; sub: string; run: () => void }[] = [
    ...(typedPath ? [{ label: `Use ${tilde(typedPath, home)}`, sub: typedPath === q.trim() ? "typed path" : `typed path: ${q.trim()}`, run: () => pick(typedPath) }] : []),
    ...list.map((f) => ({ label: f.name, sub: tilde(f.path, home) + (f.repo ? "" : " · not a git repo"), run: () => pick(f.path) })),
    { label: "Choose a folder…", sub: "macOS folder dialog", run: () => void browse() },
  ];
  function pick(p: string) { onChange(p); setOpenList(false); setQ(""); }
  async function browse() {
    const dir = await open({ directory: true, multiple: false, defaultPath: value.startsWith("~") ? undefined : value }).catch(() => null);
    if (typeof dir === "string") pick(dir);
  }
  useEffect(() => setSel(0), [q, openList]);

  const shown = value ? tilde(value, home) : "";
  const name = value ? shown.split("/").filter(Boolean).at(-1) ?? shown : "Choose a folder…";
  return (
    <div ref={box} style={{ position: "relative", flex: "0 1 240px", minWidth: 0 }} data-mr="FolderPicker" data-mr-source={value}>
      <button type="button" className="mr-row" aria-label={value ? `Work folder: ${shown}. Change` : "Choose a folder"} onClick={() => setOpenList((x) => !x)}
        style={{ width: "100%", border: 0, background: "var(--mr-well)", font: "inherit", color: "var(--mr-ink)", padding: "8px 10px", cursor: "pointer", textAlign: "left", gap: 8 }}>
        <span aria-hidden>▤</span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <strong className="mr-ellipsis" style={{ fontSize: 14 }}>{name}</strong>
          <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 11 }}>{shown}</span>
        </span>
        <span className="mr-dim" aria-hidden>▾</span>
      </button>
      {openList && (
        <div role="listbox" aria-label="Work folders" className="mr-pop" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, width: 440, zIndex: 20, background: "var(--mr-tile)", boxShadow: "0 0 0 1px var(--mr-ink-3), 0 8px 24px rgba(21,24,27,.2)", display: "flex", flexDirection: "column" }}
          onKeyDown={(e) => {
            const k = keyOf(e);
            if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(k)) { e.preventDefault(); e.stopPropagation(); }
            if (k === "ArrowDown") setSel((x) => Math.min(rows.length - 1, x + 1));
            if (k === "ArrowUp") setSel((x) => Math.max(0, x - 1));
            if (k === "Enter") rows[sel]?.run();
            if (k === "Escape") setOpenList(false);
          }}>
          <input autoFocus className="mr-input" placeholder="Filter, or type a path (~/code/app, ../other)" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: 8, background: "var(--mr-well)" }} aria-label="Filter folders" />
          {rows.map((r, i) => (
            <button key={r.label + r.sub} type="button" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={r.run}
              style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, border: 0, padding: "7px 12px", font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--mr-ink)", background: i === sel ? "var(--mr-well)" : "transparent", boxShadow: i === sel ? "inset 3px 0 0 var(--mr-selected)" : undefined }}>
              <span>{r.label}</span><span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 11, maxWidth: "100%" }}>{r.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
