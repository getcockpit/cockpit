import { useEffect, useState } from "react";
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
  const state = useAppState();
  const docs = useDocs();
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
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "b") { e.preventDefault(); setBuilds((x) => (x === null ? "" : null)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const voice = <VoiceController resolve={resolve} send={(sid, text) => void api.send(sid, text)} onFallback={(text) => { setPickerText(text); setPicker(true); }} />;
  const buildsPanel = builds !== null && <Builds defaultWorktree={builds || undefined} onClose={() => setBuilds(null)} />;
  const overlay = picker && <StartPicker state={state} initialText={pickerText} onClose={() => { setPicker(false); setPickerText(""); }} onStarted={(id) => { setPicker(false); setDocId(null); setFocus(id); }} />;
  const doc = docId ? docs.find((d) => d.id === docId) : null;
  if (doc) return <>{<DocMap doc={doc} state={state} onBack={() => setDocId(null)} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />}{overlay}{buildsPanel}{godmode}{voice}</>;
  const focused = focus ? state.sessions[focus] : null;
  if (focused) return <>{<div className="mr-zoom-in" style={{ height: "100%" }}><Focus s={focused} docs={docs.filter((d) => d.session_id === focused.id)} onOpenDoc={setDocId} onBuild={(wt) => setBuilds(wt)} onBack={() => setFocus(null)} /></div>}{overlay}{buildsPanel}{godmode}{voice}</>;
  return <><Wall state={state} docs={docs} onOpen={setFocus} onOpenDoc={setDocId} onStart={() => setPicker(true)} />{overlay}{buildsPanel}{godmode}{voice}</>;
}
