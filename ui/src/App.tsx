import { keyOf } from "./components/keys";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { needsLayer2, wantsDiagram } from "./picker/pick";
import { WorkspaceSwitcher, WorkspaceTabs } from "./screens/Workspaces";
import { Settings } from "./screens/Settings";
import { Onboarding } from "./screens/Onboarding";
import { Archive } from "./screens/Archive";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
  // Text size scales the whole UI; density changes spacing (MR-50). Both apply instantly.
  useEffect(() => {
    const r = document.documentElement;
    (r.style as CSSStyleDeclaration & { zoom: string }).zoom = String(all.look.scale);
    r.dataset.density = all.look.density === "default" ? "" : all.look.density;
  }, [all.look]);
  useEffect(() => { try { localStorage.setItem("mr.workspace", workspace); } catch { /* per-viewer convenience */ } }, [workspace]);
  // Plan limits: the sidecar reads them on start; refresh every 5 minutes after that.
  useEffect(() => { const t = setInterval(() => void api.refreshLimits().catch(() => {}), 5 * 60_000); return () => clearInterval(t); }, []);
  // Picker layer 2: classify a finished turn's prose once; the answer comes back as a picker.layer2 event.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const sess of Object.values(all.sessions)) {
      const item = needsLayer2(sess);
      if (!item || asked.current.has(item.id)) continue;
      asked.current.add(item.id);
      api.classify(sess.id, item.id, item.text).catch(() => {});
    }
    // Picker layer 3: long structured prose gets a diagram in the background.
    for (const sess of Object.values(all.sessions)) {
      const item = wantsDiagram(sess);
      if (!item || asked.current.has(`d:${item.id}`)) continue;
      asked.current.add(`d:${item.id}`);
      api.diagram(sess.id, item.id, item.text).catch(() => {});
    }
  }, [all.sessions]);
  // Each workspace sees only its own sessions and docs (decision 24).
  const state: AppState = useMemo(() => {
    // Archived sessions stay reachable (focus, archive) but leave the wall's order.
    const mine = all.order.filter((id) => all.sessions[id].workspace === workspace);
    const order = mine.filter((id) => !all.sessions[id].archivedAt);
    return { ...all, order, sessions: Object.fromEntries(mine.map((id) => [id, all.sessions[id]])) };
  }, [all, workspace]);
  const docs = useMemo(() => allDocs.filter((d) => (d.session_id ? all.sessions[d.session_id]?.workspace === workspace : workspace === "personal")), [allDocs, all, workspace]);
  const [focus, setFocus] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  // Each workspace remembers where you were (wall, a session or a doc), so switching back is a return, not a restart.
  const views = useRef<Record<string, { focus: string | null; docId: string | null }>>({});
  const [switcher, setSwitcher] = useState(false);
  const switchTo = (id: string) => {
    if (id === workspace) return;
    views.current[workspace] = { focus, docId };
    const back = views.current[id] ?? { focus: null, docId: null };
    setFocus(back.focus && all.sessions[back.focus]?.workspace === id ? back.focus : null);
    setDocId(back.docId);
    setWorkspace(id);
  };
  const [picker, setPicker] = useState(false);
  const [god, setGod] = useState(false);
  const [builds, setBuilds] = useState<string | null>(null); // worktree to build, "" = app repo
  const [pickerText, setPickerText] = useState("");
  const [pickerMode, setPickerMode] = useState<"review" | "address" | undefined>(undefined);
  const [archive, setArchive] = useState(false);
  // First run: show the intro until it's finished or skipped (ui.onboarded); wait for the replay.
  const [introClosed, setIntroClosed] = useState(false);
  const intro = all.lastEventId !== null && !all.onboarded && !introClosed && <Onboarding state={all} onDone={() => setIntroClosed(true)} onStart={(kind) => { if (all.order.length > 0 || kind === "review" || kind === "address") setPicker(true); }} />;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && keyOf(e) === "k") { e.preventDefault(); setPicker(true); }
      if (e.metaKey && e.shiftKey && keyOf(e) === "g") { e.preventDefault(); setGod((x) => !x); }
      if (e.metaKey && keyOf(e) === ",") { e.preventDefault(); setSettings((x) => !x); }
      if (e.metaKey && e.shiftKey && keyOf(e) === "a") { e.preventDefault(); setArchive((x) => !x); }
      if (e.metaKey && e.shiftKey && keyOf(e) === "b") { e.preventDefault(); setBuilds((x) => (x === null ? "" : null)); }
      if (e.metaKey && /^[1-9]$/.test(keyOf(e)) && !e.shiftKey) {
        const ws = all.workspaces[Number(keyOf(e)) - 1];
        if (ws && !document.querySelector('[role="dialog"]')) { e.preventDefault(); switchTo(ws.id); }
      }
      // ⌃Tab / ⌃⇧Tab cycle workspaces like browser tabs; ⌘J opens the switcher (MR-55).
      if (e.ctrlKey && keyOf(e) === "Tab" && all.workspaces.length > 1 && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        const i = all.workspaces.findIndex((w) => w.id === workspace);
        switchTo(all.workspaces[(i + (e.shiftKey ? -1 : 1) + all.workspaces.length) % all.workspaces.length].id);
      }
      if (e.metaKey && keyOf(e) === "j") { e.preventDefault(); setSwitcher((x) => !x); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const view = docId ? "doc map" : focus ? "focus" : "wall";
  const godmode = <GodMode on={god} onOpen={() => setGod(true)} sessionAction={(src) => { const x = state.sessions[src.split(":")[0]]; return x && !x.archivedAt ? { label: "Mark done & archive", run: () => { void api.archive(x); if (focus === x.id) setFocus(null); } } : null; }} onClose={() => setGod(false)} view={view} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />;
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
  const tabs = <WorkspaceTabs state={all} docs={allDocs} active={workspace} onSwitch={switchTo} onSwitcher={() => setSwitcher(true)} onSignIn={setSignIn} onSettings={() => setSettings(true)} />;
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
  const archived = Object.values(state.sessions).filter((x) => x.archivedAt);
  const archivePanel = archive && <Archive sessions={archived} onClose={() => setArchive(false)} onOpen={(id) => { setArchive(false); setDocId(null); setFocus(id); }} />;
  const overlay = picker && <StartPicker state={state} initialText={pickerText} initialMode={pickerMode} onClose={() => { setPicker(false); setPickerText(""); setPickerMode(undefined); }} onStarted={(id) => { setPicker(false); setDocId(null); setFocus(id); }} />;
  // App shell: the workspace tabs stay put and only the view scrolls, so sticky headers work and
  // nothing pushes the tabs off-screen (MR-43).
  const shell = (view: React.ReactNode, overlays: React.ReactNode) => (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {tabs}
      <div id="mr-view" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{view}</div>
      {overlays}
    </div>
  );
  const doc = docId ? docs.find((d) => d.id === docId) : null;
  if (doc) return shell(<ErrorBoundary key={`doc:${doc.id}`} name="working doc">{<DocMap doc={doc} state={state} onBack={() => setDocId(null)} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />}</ErrorBoundary>, <>{overlay}{buildsPanel}{signInPanel}{settings && <Settings state={all} onClose={() => setSettings(false)} onOpenSession={(id) => { setSettings(false); setDocId(null); setFocus(id); }} />}{archivePanel}{switcher && <WorkspaceSwitcher state={all} docs={allDocs} active={workspace} onSwitch={switchTo} onClose={() => setSwitcher(false)} />}{godmode}{voice}{intro}</>);
  const focused = focus ? state.sessions[focus] : null;
  if (focused) return shell(<ErrorBoundary key={`focus:${focused.id}`} name="session">{<div className="mr-zoom-in" style={{ height: "100%" }}><Focus s={focused} onDone={() => { void api.archive(focused); setFocus(null); }} docs={docs.filter((d) => d.session_id === focused.id)} onOpenDoc={setDocId} onBuild={(wt) => setBuilds(wt)} onBack={() => setFocus(null)} /></div>}</ErrorBoundary>, <>{overlay}{buildsPanel}{signInPanel}{settings && <Settings state={all} onClose={() => setSettings(false)} onOpenSession={(id) => { setSettings(false); setDocId(null); setFocus(id); }} />}{archivePanel}{switcher && <WorkspaceSwitcher state={all} docs={allDocs} active={workspace} onSwitch={switchTo} onClose={() => setSwitcher(false)} />}{godmode}{voice}{intro}</>);
  return shell(<ErrorBoundary key="wall" name="wall"><Wall state={state} docs={docs} onBuild={(wt) => setBuilds(wt)} archived={archived.length} onArchive={() => setArchive(true)} onOpen={setFocus} onOpenDoc={setDocId} onStart={(init) => { if (init) { setPickerMode(init.mode); setPickerText(init.text); } setPicker(true); }} /></ErrorBoundary>, <>{overlay}{buildsPanel}{signInPanel}{settings && <Settings state={all} onClose={() => setSettings(false)} onOpenSession={(id) => { setSettings(false); setDocId(null); setFocus(id); }} />}{archivePanel}{switcher && <WorkspaceSwitcher state={all} docs={allDocs} active={workspace} onSwitch={switchTo} onClose={() => setSwitcher(false)} />}{godmode}{voice}{intro}</>);
}
