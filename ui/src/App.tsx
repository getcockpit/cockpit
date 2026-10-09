import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { WorkspaceTabs } from "./screens/Workspaces";
import { Settings } from "./screens/Settings";
import type { AppState } from "./state/types";
const SignInPane = lazy(() => import("./screens/Terminal").then((m) => ({ default: m.SignInPane })));
import { Focus } from "./screens/Focus";
import { StartPicker } from "./screens/StartPicker";
import { DocMap } from "./screens/DocMap";
import { Wall } from "./screens/Wall";
import { GodMode } from "./screens/GodMode";
import { Builds } from "./screens/Builds";
import { VoiceController, type PointTarget } from "./screens/Voice";
import { api } from "./state/store";
import { useDocs } from "./state/docs";
import { useAppState } from "./state/store";

export default function App() {
  const all = useAppState();
  const allDocs = useDocs();
  const [workspace, setWorkspace] = useState(() => { try { return localStorage.getItem("mr.workspace") ?? "personal"; } catch { return "personal"; } });
  const [signIn, setSignIn] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  // The theme is part of the log (synced, durable); applying it is just a data attribute.
  useEffect(() => { document.documentElement.dataset.theme = all.theme === "control-room" ? "" : all.theme; }, [all.theme]);
  useEffect(() => { try { localStorage.setItem("mr.workspace", workspace); } catch { /* per-viewer convenience */ } }, [workspace]);
  // Each workspace sees only its own sessions and docs (decision 24).
  const state: AppState = useMemo(() => {
    const order = all.order.filter((id) => all.sessions[id].workspace === workspace);
    return { ...all, order, sessions: Object.fromEntries(order.map((id) => [id, all.sessions[id]])) };
  }, [all, workspace]);
  const docs = useMemo(() => allDocs.filter((d) => (d.session_id ? all.sessions[d.session_id]?.workspace === workspace : workspace === "personal")), [allDocs, all, workspace]);
  const [focus, setFocus] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [god, setGod] = useState(false);
  const [builds, setBuilds] = useState<string | null>(null); // worktree to build, "" = app repo
  const [pickerText, setPickerText] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "k") { e.preventDefault(); setPicker(true); }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "g") { e.preventDefault(); setGod((x) => !x); }
      if (e.metaKey && e.key === ",") { e.preventDefault(); setSettings((x) => !x); }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "b") { e.preventDefault(); setBuilds((x) => (x === null ? "" : null)); }
      if (e.metaKey && /^[1-9]$/.test(e.key) && !e.shiftKey) {
        const ws = all.workspaces[Number(e.key) - 1];
        if (ws && !document.querySelector('[role="dialog"]')) { e.preventDefault(); setFocus(null); setDocId(null); setWorkspace(ws.id); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [all.workspaces]);

  const view = docId ? "doc map" : focus ? "focus" : "wall";
  const godmode = <GodMode on={god} onClose={() => setGod(false)} view={view} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />;
  // Point + talk: which session does the thing under the pointer belong to?
  const resolve = (t: PointTarget) => {
    const label = (id: string) => `“${(state.sessions[id]?.title ?? "session").slice(0, 40)}”`;
    if (state.sessions[t.source]) return { session: t.source, label: label(t.source) };
    const sid = t.source.split(":")[0];
    if (state.sessions[sid]) return { session: sid, label: label(sid) };
    if (t.component.startsWith("DocBlock")) { const d = docs.find((x) => x.id === sid); if (d?.session_id && state.sessions[d.session_id]) return { session: d.session_id, label: `the session behind “${d.title}”` }; }
    if (focus && state.sessions[focus]) return { session: focus, label: label(focus) };
    return null;
  };
  const tabs = <WorkspaceTabs state={all} docs={allDocs} active={workspace} onSwitch={(id) => { setFocus(null); setDocId(null); setWorkspace(id); }} onSignIn={setSignIn} onSettings={() => setSettings(true)} />;
  const signInPanel = signIn && (
    <div role="dialog" aria-label="Sign in to workspace" style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "80px 24px", background: "rgba(21,24,27,.35)", zIndex: 30 }}>
      <div style={{ width: "100%", maxWidth: 900, padding: 16, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="mr-row"><strong>Sign in to “{all.workspaces.find((w) => w.id === signIn)?.name}”</strong><span className="mr-grow" /><button type="button" className="mr-key" onClick={() => setSignIn(null)}>Close</button></div>
        <Suspense fallback={<span className="mr-dim">Opening…</span>}><SignInPane workspace={signIn} onExit={() => setSignIn(null)} /></Suspense>
      </div>
    </div>
  );
  const voice = <VoiceController resolve={resolve} send={(sid, text) => void api.send(sid, text)} onFallback={(text) => { setPickerText(text); setPicker(true); }} />;
  const buildsPanel = builds !== null && <Builds defaultWorktree={builds || undefined} onClose={() => setBuilds(null)} />;
  const overlay = picker && <StartPicker state={state} initialText={pickerText} onClose={() => { setPicker(false); setPickerText(""); }} onStarted={(id) => { setPicker(false); setDocId(null); setFocus(id); }} />;
  const doc = docId ? docs.find((d) => d.id === docId) : null;
  if (doc) return <>{tabs}{<DocMap doc={doc} state={state} onBack={() => setDocId(null)} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />}{overlay}{buildsPanel}{signInPanel}{settings && <Settings state={all} onClose={() => setSettings(false)} />}{godmode}{voice}</>;
  const focused = focus ? state.sessions[focus] : null;
  if (focused) return <>{tabs}{<div className="mr-zoom-in" style={{ height: "100%" }}><Focus s={focused} docs={docs.filter((d) => d.session_id === focused.id)} onOpenDoc={setDocId} onBuild={(wt) => setBuilds(wt)} onBack={() => setFocus(null)} /></div>}{overlay}{buildsPanel}{signInPanel}{settings && <Settings state={all} onClose={() => setSettings(false)} />}{godmode}{voice}</>;
  return <>{tabs}<Wall state={state} docs={docs} onOpen={setFocus} onOpenDoc={setDocId} onStart={() => setPicker(true)} />{overlay}{buildsPanel}{signInPanel}{settings && <Settings state={all} onClose={() => setSettings(false)} />}{godmode}{voice}</>;
}
