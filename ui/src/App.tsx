import { useEffect, useState } from "react";
import { Focus } from "./screens/Focus";
import { StartPicker } from "./screens/StartPicker";
import { DocMap } from "./screens/DocMap";
import { Wall } from "./screens/Wall";
import { useDocs } from "./state/docs";
import { useAppState } from "./state/store";

export default function App() {
  const state = useAppState();
  const docs = useDocs();
  const [focus, setFocus] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "k") { e.preventDefault(); setPicker(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const overlay = picker && <StartPicker state={state} onClose={() => setPicker(false)} onStarted={(id) => { setPicker(false); setDocId(null); setFocus(id); }} />;
  const doc = docId ? docs.find((d) => d.id === docId) : null;
  if (doc) return <>{<DocMap doc={doc} state={state} onBack={() => setDocId(null)} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />}{overlay}</>;
  const focused = focus ? state.sessions[focus] : null;
  if (focused) return <>{<div className="mr-zoom-in" style={{ height: "100%" }}><Focus s={focused} docs={docs.filter((d) => d.session_id === focused.id)} onOpenDoc={setDocId} onBack={() => setFocus(null)} /></div>}{overlay}</>;
  return <><Wall state={state} docs={docs} onOpen={setFocus} onOpenDoc={setDocId} onStart={() => setPicker(true)} />{overlay}</>;
}
