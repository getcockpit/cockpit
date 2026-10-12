import { BuildReadyBanner } from "./components/BuildReadyBanner";
import { RecoveryBanner } from "./components/RecoveryBanner";
import { keyOf } from "./components/keys";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { needsLayer2 } from "./picker/pick";
import { DeleteWorkspace, WorkspaceSwitcher, WorkspaceTabs } from "./screens/Workspaces";
import { Settings } from "./screens/Settings";
import { Onboarding } from "./screens/Onboarding";
import { Archive } from "./screens/Archive";
import { Toast } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { navigate, Presence } from "./components/motion";
import type { AppState } from "./state/types";
import { elsewhere, introOpen } from "./state/reduce";
const SignInPane = lazy(() => import("./screens/Terminal").then((m) => ({ default: m.SignInPane })));
import { Focus } from "./screens/Focus";
import { StartPicker } from "./screens/StartPicker";
import { DocMap } from "./screens/DocMap";
import { Wall } from "./screens/Wall";
import { Timeline } from "./screens/Timeline";
import { GodMode } from "./screens/GodMode";
import { startUpdate, UpdateBanner } from "./screens/UpdateBanner";
import { Builds } from "./screens/Builds";
import { VoiceController, type PointTarget } from "./screens/Voice";
import { api } from "./state/store";
import { docApi, docsOf, useDocs } from "./state/docs";
import { useAppState } from "./state/store";
import { useAutoReview } from "./state/useAutoReview";
import { useNotify } from "./state/notify";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { installUsage, useViews } from "./state/usage";

export default function App() {
  const all = useAppState();
  useAutoReview(all);
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
    // Picker layer 3 (diagrams) runs only from the Diagram button: each one is a Haiku call on the user's plan.
  }, [all.sessions]);
  // Each workspace sees only its own sessions and docs (decision 24).
  const state: AppState = useMemo(() => {
    // Archived sessions stay reachable (focus, archive) but leave the wall's order.
    const mine = all.order.filter((id) => all.sessions[id].workspace === workspace);
    const order = mine.filter((id) => !all.sessions[id].archivedAt);
    return { ...all, order, sessions: Object.fromEntries(mine.map((id) => [id, all.sessions[id]])) };
  }, [all, workspace]);
  const docs = useMemo(() => allDocs.filter((d) => (d.session_id ? all.sessions[d.session_id]?.workspace === workspace : workspace === "personal")), [allDocs, all, workspace]);
  const [focus, setFocusNow] = useState<string | null>(null);
  const [docId, setDocIdNow] = useState<string | null>(null);
  // Screen changes morph (MR-67): opening something goes deeper, closing it comes back.
  const setFocus = (id: string | null) => navigate(id ? "deeper" : "back", () => setFocusNow(id));
  const setDocId = (id: string | null) => navigate(id ? "deeper" : "back", () => setDocIdNow(id));
  // Each workspace remembers where you were (wall, a session or a doc), so switching back is a return, not a restart.
  const views = useRef<Record<string, { focus: string | null; docId: string | null }>>({});
  const [switcher, setSwitcher] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // If the open workspace disappears (deleted), fall back to Personal.
  useEffect(() => { if (all.lastEventId !== null && !all.workspaces.some((w) => w.id === workspace)) { setFocusNow(null); setDocIdNow(null); setWorkspace("personal"); } }, [all.workspaces, workspace]);
  const switchTo = (id: string) => {
    if (id === workspace) return;
    views.current[workspace] = { focus, docId };
    const back = views.current[id] ?? { focus: null, docId: null };
    navigate("side", () => {
      setFocusNow(back.focus && all.sessions[back.focus]?.workspace === id ? back.focus : null);
      setDocIdNow(back.docId);
      setWorkspace(id);
    });
  };
  const [picker, setPicker] = useState(false);
  const [god, setGod] = useState(false);
  const [builds, setBuilds] = useState<string | null>(null); // worktree to build, "" = app repo
  const [pickerText, setPickerText] = useState("");
  const [pickerMode, setPickerMode] = useState<"review" | "address" | undefined>(undefined);
  const [archive, setArchive] = useState(false);
  // Wall or Timeline (decision 29, MR-32): remembered per viewer, like the open workspace.
  const [wallView, setWallViewNow] = useState<"wall" | "timeline">(() => { try { return localStorage.getItem("mr.wallView") === "timeline" ? "timeline" : "wall"; } catch { return "wall"; } });
  const setWallView = (v: "wall" | "timeline") => navigate("side", () => { setWallViewNow(v); try { localStorage.setItem("mr.wallView", v); } catch { /* per-viewer convenience */ } });
  // First run: show the intro until it's finished or skipped (ui.onboarded); wait for the replay.
  const [introClosedAt, setIntroClosedAt] = useState<string | null>(null);
  const intro = introOpen(all, introClosedAt) && <Onboarding state={all} onDone={() => setIntroClosedAt(all.lastEventId)} onStart={(kind) => { if (all.order.length > 0 || kind === "review" || kind === "address") setPicker(true); }} />;
  // A notification's click lands on its decision (MR-94): its workspace, then the session or doc, over anything open.
  useNotify(all, allDocs, { workspace, session: focus, doc: docId }, (t) => {
    const w = getCurrentWindow();
    void w.unminimize().then(() => w.show()).then(() => w.setFocus()).catch(() => {});
    setPicker(false); setArchive(false); setSettings(false); setGod(false); setBuilds(null);
    views.current[workspace] = { focus, docId };
    navigate("deeper", () => { setWorkspace(t.workspace); setDocIdNow(t.doc); setFocusNow(t.session); });
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && keyOf(e) === "k") { e.preventDefault(); setPicker(true); }
      if (e.metaKey && e.shiftKey && keyOf(e) === "g") { e.preventDefault(); setGod((x) => !x); }
      if (e.metaKey && keyOf(e) === ",") { e.preventDefault(); setSettings((x) => !x); }
      if (e.metaKey && e.shiftKey && keyOf(e) === "a") { e.preventDefault(); setArchive((x) => !x); }
      // ⌘⇧B updates the app from main (decision 27); ⌘⌥⇧B still opens the build history.
      if (e.metaKey && e.shiftKey && keyOf(e) === "b") { e.preventDefault(); if (e.altKey) setBuilds((x) => (x === null ? "" : null)); else void startUpdate().catch(() => {}); }
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
      // T switches Wall ↔ Timeline, only on those screens and never while typing.
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      if (keyOf(e) === "t" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing && !focus && !docId && !document.querySelector('[role="dialog"]')) { e.preventDefault(); setWallView(wallView === "wall" ? "timeline" : "wall"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const view = docId ? "doc map" : focus ? "focus" : wallView;
  // Feature usage (MR-83): the main screen first, then every open overlay.
  useEffect(() => installUsage(), []);
  useViews([view, picker && "start picker", settings && "settings", god && "god mode", archive && "archive", builds !== null && "builds", switcher && "workspace switcher", signIn && "sign in", deleting && "delete workspace", intro && "intro"].filter((v): v is string => typeof v === "string"));
  const godmode = <GodMode on={god} onOpen={() => setGod(true)} sessionAction={(src, component) => { if (component === "WorkspaceTab") return src !== "personal" ? { label: "Delete workspace…", run: () => setDeleting(src) } : null; const x = state.sessions[src.split(":")[0]]; return x && !x.archivedAt ? { label: "Mark done & archive", run: () => { void api.archive(x); if (focus === x.id) setFocus(null); } } : null; }} onClose={() => setGod(false)} view={view} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />;
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
    <div role="dialog" aria-label="Sign in to workspace" className="mr-scrim" style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "80px 24px", background: "rgba(21,24,27,.35)", zIndex: 30 }}>
      <div className="mr-sheet" style={{ width: "100%", maxWidth: 900, padding: 16, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="mr-row"><strong>Sign in to “{all.workspaces.find((w) => w.id === signIn)?.name}”</strong><span className="mr-grow" /><button type="button" className="mr-key" onClick={() => setSignIn(null)}>Close</button></div>
        <Suspense fallback={<span className="mr-dim">Opening…</span>}><SignInPane workspace={signIn} onExit={() => setSignIn(null)} /></Suspense>
      </div>
    </div>
  );
  // Voice "catch me up" (MR-116): a brief of the session pointed at, else the one open in Focus.
  const catchUp = (sid: string | null) => { const target = sid ?? focus; if (target) void docApi.brief(target).then((r) => setDocId(r.doc_id)).catch(() => {}); };
  const voice = <VoiceController resolve={resolve} send={(sid, text) => void api.send(sid, text)} onCatchUp={catchUp} onFallback={(text) => { setPickerText(text); setPicker(true); }} />;
  const buildsPanel = builds !== null && <Builds defaultWorktree={builds || undefined} onClose={() => setBuilds(null)} />;
  const archived = Object.values(state.sessions).filter((x) => x.archivedAt);
  const archivePanel = archive && <Archive sessions={archived} onClose={() => setArchive(false)} onOpen={(id) => { setArchive(false); setDocId(null); setFocus(id); }} />;
  const overlay = picker && <StartPicker state={state} workspace={workspace} initialText={pickerText} initialMode={pickerMode} onClose={() => { setPicker(false); setPickerText(""); setPickerMode(undefined); }} onStarted={(id) => { setPicker(false); setDocId(null); setFocus(id); }} />;
  // App shell: the workspace tabs stay put and only the view scrolls, so sticky headers work and
  // nothing pushes the tabs off-screen (MR-43).
  const shell = (view: React.ReactNode, overlays: React.ReactNode) => (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {tabs}
      <RecoveryBanner all={all} />
      <BuildReadyBanner all={all} />
      <UpdateBanner all={all} onOpenSession={(id) => { setDocId(null); setFocus(id); }} onBuild={() => setBuilds("")} />
      <div id="mr-view" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{view}</div>
      {overlays}
    </div>
  );
  const overlays = <>
      <Presence show={picker}>{overlay}</Presence>
      <Presence show={builds !== null}>{buildsPanel}</Presence>
      <Presence show={!!signIn}>{signInPanel}</Presence>
      <Presence show={settings}><Settings state={all} onDeleteWorkspace={(id) => { setSettings(false); setDeleting(id); }} onClose={() => setSettings(false)} onOpenSession={(id) => { setSettings(false); setDocId(null); setFocus(id); }} /></Presence>
      <Presence show={archive}>{archivePanel}</Presence>
      <Toast />
      <Presence show={!!deleting}>{deleting && <DeleteWorkspace state={all} docs={allDocs} id={deleting} onClose={() => setDeleting(null)} onDeleted={() => setDeleting(null)} />}</Presence>
      <Presence show={switcher}><WorkspaceSwitcher state={all} docs={allDocs} active={workspace} onSwitch={switchTo} onClose={() => setSwitcher(false)} /></Presence>
      {godmode}{voice}<Presence show={!!intro}>{intro}</Presence>
    </>;
  const doc = docId ? docs.find((d) => d.id === docId) : null;
  if (doc) return shell(<ErrorBoundary key={`doc:${doc.id}`} name="working doc">{<DocMap doc={doc} state={state} onBack={() => setDocId(null)} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />}</ErrorBoundary>, overlays);
  const focused = focus ? state.sessions[focus] : null;
  if (focused) return shell(<ErrorBoundary key={`focus:${focused.id}`} name="session">{<div className="mr-zoom-in" style={{ height: "100%" }}><Focus s={focused} elsewhere={elsewhere(state, focused)} models={state.models} onDone={() => { void api.archive(focused); setFocus(null); }} docs={docsOf(docs, focused.id)} onOpenDoc={setDocId} onBuild={(wt) => setBuilds(wt)} onBack={() => setFocus(null)} /></div>}</ErrorBoundary>, overlays);
  if (wallView === "timeline") return shell(<ErrorBoundary key="timeline" name="timeline"><Timeline state={state} docs={docs} onOpen={setFocus} onOpenDoc={setDocId} onWall={() => setWallView("wall")} /></ErrorBoundary>, overlays);
  return shell(<ErrorBoundary key="wall" name="wall"><Wall state={state} onTimeline={() => setWallView("timeline")} workspace={workspace} docs={docs} onBuild={(wt) => setBuilds(wt)} archived={archived.length} onArchive={() => setArchive(true)} onOpen={setFocus} onOpenDoc={setDocId} onStart={(init) => { if (init) { setPickerMode(init.mode); setPickerText(init.text); } setPicker(true); }} /></ErrorBoundary>, overlays);
}
