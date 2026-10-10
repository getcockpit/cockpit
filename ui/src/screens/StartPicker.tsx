import { keyOf } from "../components/keys";
import { FolderPicker, PinFolder, useWorkFolder } from "../components/FolderPicker";
import { workspaceFolder } from "../state/reduce";
import { cleanTitle } from "../picker/title";
import { prRepo, prSlug, rememberPrRepo } from "../state/prRepo";
import { shortError } from "../components/ErrorLine";
import { useEffect, useMemo, useRef, useState } from "react";
import { Key } from "../components";
import { api, type Pr } from "../state/store";
import { addressNote, toAddress } from "../picker/suggest";
import type { AppState, Preset, SessionKind } from "../state/types";

// ⌘K start picker (decision 18): Review / Address / Plan / Blank, each with its own suggestions.
const MODES: { id: SessionKind; name: string; what: string; placeholder: string }[] = [
  { id: "blank", name: "Blank", what: "Any task, straight away", placeholder: "What should Claude do?" },
  { id: "plan", name: "Plan", what: "A working doc first, code later", placeholder: "Describe what you want to build…" },
  { id: "review", name: "Review", what: "Your /review on a PR", placeholder: "PR number or URL, e.g. 4412" },
  { id: "address", name: "Address", what: "Your /pr-address, thread by thread", placeholder: "Your PR number" },
];

// Your own kinds (MR-80) sit next to the built-in ones; their mode id is `p:<preset id>`.
const presetMode = (id: string) => `p:${id}`;

// A template's `{text}` is what you type; without one, your text goes after it.
export function fill(template: string, text: string): string {
  const t = text.trim();
  return template.includes("{text}") ? template.split("{text}").join(t).trim() : `${template.trim()} ${t}`.trim();
}

// The text you typed, back out of a filled template, so a recent prompt can be reused.
export function unfill(template: string, prompt: string): string {
  const [pre, ...rest] = (template.includes("{text}") ? template : `${template.trim()} {text}`).split("{text}");
  const post = rest.join("{text}");
  let t = prompt;
  if (pre && t.startsWith(pre.trim())) t = t.slice(pre.trim().length);
  if (post.trim() && t.endsWith(post.trim())) t = t.slice(0, -post.trim().length);
  return t.trim();
}

// What each mode actually sends to Claude Code. Review/Address use the user's own commands.
export function promptFor(mode: SessionKind, text: string): string {
  const t = text.trim();
  if (mode === "review") return `/review ${t}`;
  if (mode === "address") return `/pr-address ${t}`;
  if (mode === "plan") return `Plan this with me before any code: ${t}. Write the plan as a working document using the mr doc tools.`;
  return t;
}

// What happens when you press Start, per kind (shown in the footer instead of stale copy).
const HOW: Record<SessionKind, string> = {
  blank: "Runs in its own git worktree, so your checkout stays clean",
  plan: "Writes a working doc you annotate; no code until you say so",
  review: "Runs your /review and shows its findings step by step",
  address: "Runs your /pr-address and walks each reviewer thread",
};

type Item = { ref: string; title: string; meta: string; hot: boolean; value: string; repo?: string };

type Draft = { id: string | null; name: string; template: string; worktree: boolean };

export function StartPicker({ state, workspace = "personal", onClose, onStarted, initialText = "", initialMode }: { state: AppState; workspace?: string; onClose: () => void; onStarted: (id: string) => void; initialText?: string; initialMode?: SessionKind }) {
  // Opens on the kind you used last (F6); dictated text always starts a blank session.
  const [modeRaw, setModeRaw] = useState<string>(() => { if (initialMode) return initialMode; if (initialText) return "blank"; try { return localStorage.getItem("mr.mode") || "blank"; } catch { return "blank"; } });
  const setMode = (m: string) => { setModeRaw(m); setDraft(null); try { localStorage.setItem("mr.mode", m); } catch { /* convenience only */ } };
  const preset: Preset | null = state.presets.find((x) => presetMode(x.id) === modeRaw) ?? null;
  // A removed preset (or a stale stored mode) falls back to Blank.
  const mode: SessionKind = preset ? "blank" : MODES.some((x) => x.id === modeRaw) ? (modeRaw as SessionKind) : "blank";
  const modeId = preset ? modeRaw : mode;
  const tiles = [...MODES.map((x) => ({ id: x.id as string, name: x.name, what: x.what, mono: false })), ...state.presets.map((x) => ({ id: presetMode(x.id), name: x.name, what: x.template, mono: true }))];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState(initialText);
  const [cwd, setCwd] = useWorkFolder(workspaceFolder(state, workspace));
  const [prs, setPrs] = useState<Pr[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const prMode = mode === "review" || mode === "address";
  // PR lists cover every repo (MR-48) unless "only this repo" is on (MR-79): then the folder picks
  // the repo. `repo` is undefined while the folder's origin is being read, null when it isn't GitHub.
  const [only, setOnlyRaw] = useState(() => { try { return localStorage.getItem("mr.prs.only") === "1"; } catch { return false; } });
  const setOnly = (v: boolean) => { setOnlyRaw(v); try { localStorage.setItem("mr.prs.only", v ? "1" : "0"); } catch { /* convenience only */ } };
  const [repo, setRepo] = useState<string | null | undefined>(undefined);
  const scope = only && repo ? repo : undefined;

  useEffect(() => { if (!draft) input.current?.focus(); }, [modeId, draft]);
  useEffect(() => {
    let alive = true;
    setRepo(undefined);
    api.ghRepo(cwd).then((r) => alive && setRepo(r)).catch(() => alive && setRepo(null));
    return () => { alive = false; };
  }, [cwd]);
  useEffect(() => {
    setPrs(null); setSel(0); setError("");
    if (!prMode || (only && repo === undefined)) return;
    let alive = true;
    api.prs(cwd, mode, scope).then((r) => alive && setPrs(r)).catch((e) => alive && (setPrs([]), setError(shortError(e))));
    return () => { alive = false; };
  }, [mode, cwd, scope, only && repo === undefined]);

  const items: Item[] = useMemo(() => {
    if (mode === "review" || mode === "address") {
      return (prs ?? []).map((p) => ({
        ref: `#${p.number}`, value: p.url, repo: p.repository?.nameWithOwner, title: `${p.title}${p.author ? ` · @${p.author.login}` : ""}`,
        meta: [p.repository?.nameWithOwner, mode === "address" && addressNote(p)].filter(Boolean).join(" · "),
        hot: mode === "address" ? toAddress(p) : true,
      }));
    }
    const recent = state.order.map((id) => state.sessions[id]).filter((s) => s.kind === mode && (s.preset ?? null) === (preset?.id ?? null)).reverse().slice(0, 5);
    return recent.map((s) => { const v = preset ? unfill(preset.template, s.title) : s.title; return { ref: "", value: cleanTitle(v, 400), title: cleanTitle(v), meta: new Date(s.startedAt).toLocaleDateString(), hot: false }; });
  }, [mode, preset, prs, state]);

  // PR work runs in the PR's own clone (MR-48); if it can't be found, ask once and remember.
  const [askRepo, setAskRepo] = useState<{ slug: string; value: string } | null>(null);
  const start = async (value: string, repo?: string) => {
    if (!value.trim()) return;
    setError("");
    try {
      let where = cwd;
      const slug = mode === "review" || mode === "address" ? repo ?? prSlug(value) : null;
      if (slug) {
        const found = await prRepo(slug);
        if (!found) { setAskRepo({ slug, value }); return; }
        where = found;
      }
      onStarted(preset ? await api.start(where, fill(preset.template, value), "blank", preset.worktree, undefined, preset.id) : await api.start(where, promptFor(mode, value), mode));
    } catch (e) { setError(shortError(e)); }
  };
  const useFolderFor = async (path: string) => {
    if (!askRepo) return;
    rememberPrRepo(askRepo.slug, path);
    try { onStarted(await api.start(path, promptFor(mode, askRepo.value), mode)); } catch (e) { setError(shortError(e)); }
  };

  // A PR starts its review straight away; a past prompt only fills the box, so it can be edited
  // instead of silently starting a duplicate session.
  const pick = (it: Item) => {
    if (mode === "review" || mode === "address") void start(it.value, it.repo);
    else { setText(it.value); input.current?.focus(); }
  };

  const savePreset = async (d: Draft) => {
    if (!d.name.trim() || !d.template.trim()) return;
    const id = d.id ?? Date.now().toString(36);
    try {
      await api.log("ui.preset_saved", { id, name: d.name.trim(), template: d.template.trim(), worktree: d.worktree });
      setMode(presetMode(id));
    } catch (e) { setError(shortError(e)); }
  };
  const removePreset = async (x: Preset) => {
    try { await api.log("ui.preset_removed", { id: x.id }); setMode("blank"); } catch (e) { setError(shortError(e)); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (keyOf(e) === "Escape") { e.preventDefault(); if (draft) setDraft(null); else onClose(); }
    else if (draft) return;
    else if (e.metaKey && /^[1-9]$/.test(keyOf(e)) && tiles[Number(keyOf(e)) - 1]) { e.preventDefault(); setMode(tiles[Number(keyOf(e)) - 1].id); }
    else if (keyOf(e) === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(items.length - 1, x + 1)); }
    else if (keyOf(e) === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
    else if (keyOf(e) === "Enter" && !text.trim() && items[sel]) { e.preventDefault(); pick(items[sel]); }
  };

  const m = preset ? { placeholder: preset.template.includes("{text}") ? "Fills {text} in your template" : "Goes after your template" } : MODES.find((x) => x.id === mode)!;
  return (
    <div role="dialog" className="mr-scrim" aria-label="Start something" onKeyDown={onKey}
      style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "96px 24px", background: "rgba(21,24,27,.35)", zIndex: 10 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mr-sheet" style={{ width: "100%", maxWidth: 880, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <form className="mr-row" style={{ padding: "14px 18px", background: "var(--mr-band)" }} onSubmit={(e) => { e.preventDefault(); void start(text); }}>
          {prMode && !only
            ? <span className="mr-dim" style={{ flex: "0 1 240px", padding: "0 8px" }} title="Review and Address run in the PR's own clone">Runs in the PR's repo</span>
            : <><FolderPicker value={cwd} onChange={(p) => { setCwd(p); input.current?.focus(); }} extra={[...new Set(state.order.map((id) => state.sessions[id]).reverse().map((x) => x.repo ?? x.cwd))].slice(0, 5)} />
              <PinFolder workspace={workspace} folder={cwd} pinned={state.workspaces.find((w) => w.id === workspace)?.folder ?? null} /></>}
          <input ref={input} className="mr-input" style={{ fontSize: 17, background: "var(--mr-well)" }} placeholder={m.placeholder} value={text} onChange={(e) => setText(e.target.value)} aria-label={m.placeholder} />
          <Key k="↵" tone="primary" disabled={!text.trim() && !items[sel]}>Start</Key>
        </form>
        <div role="radiogroup" aria-label="Kind of session" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "var(--mr-gap)", padding: "12px 18px" }}>
          {tiles.map((x, i) => {
            const on = x.id === modeId && !draft;
            return (
              <button key={x.id} type="button" role="radio" aria-checked={on} onClick={() => setMode(x.id)} data-mr="KindTile" data-mr-source={x.id}
                style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, border: 0, borderRadius: "var(--mr-radius)", textAlign: "left", cursor: "pointer", minWidth: 0, background: on ? "var(--mr-ink)" : "var(--mr-well)", color: on ? "var(--mr-tile)" : "var(--mr-ink)" }}>
                <span className="mr-row" style={{ justifyContent: "space-between" }}><strong className="mr-ellipsis" style={{ fontSize: 15 }}>{x.name}</strong>{i < 9 && <kbd className="mr-mono" style={{ opacity: 0.7 }}>⌘{i + 1}</kbd>}</span>
                <span className={x.mono ? "mr-mono mr-ellipsis" : undefined} style={{ opacity: 0.8 }}>{x.what}</span>
              </button>
            );
          })}
          <button type="button" data-mr="KindNew" data-mr-source="new" aria-pressed={draft?.id === null} onClick={() => setDraft({ id: null, name: "", template: "", worktree: true })}
            style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, border: 0, borderRadius: "var(--mr-radius)", textAlign: "left", cursor: "pointer", background: draft?.id === null ? "var(--mr-ink)" : "var(--mr-band)", color: draft?.id === null ? "var(--mr-tile)" : "var(--mr-ink-2)" }}>
            <strong style={{ fontSize: 15 }}>+ New</strong>
            <span style={{ opacity: 0.8 }}>Your own kind: a saved prompt</span>
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: "0 10px 10px", minHeight: 120 }}>
          {draft ? <PresetEditor draft={draft} onChange={setDraft} onSave={() => void savePreset(draft)} onCancel={() => setDraft(null)} /> : <>
          <div className="mr-row" style={{ padding: "4px 8px 8px" }}>
          <span className="mr-dim mr-grow">
            {mode === "review" ? "Waiting for your review" : mode === "address" ? `Your open PRs${prs?.some(toAddress) ? ` · ${prs.filter(toAddress).length} to address, first` : ""}` : "Reuse a recent prompt"}
            {prMode && (scope ? ` · in ${scope}` : only && repo === null ? " · this folder isn't a GitHub repo, so every repo" : "")}
            {prMode && prs === null && " · loading…"}
          </span>
          {prMode && (
            <button type="button" data-mr="RepoOnly" data-mr-source={repo ?? cwd} onClick={() => setOnly(!only)} aria-pressed={only}
              title={only ? "Showing PRs from the folder's repo only. Click to show every repo" : "Show only PRs from one repo; pick it with the folder"}
              style={{ border: 0, font: "inherit", fontSize: 12, padding: "2px 10px", cursor: "pointer", whiteSpace: "nowrap", borderRadius: "var(--mr-radius)", background: only ? "var(--mr-selected)" : "var(--mr-well)", color: only ? "var(--mr-tile)" : "var(--mr-ink)" }}>
              {only ? "This repo only" : "All repos"}
            </button>
          )}
          {preset && <>
            <button type="button" className="mr-link mr-dim" data-mr="PresetEdit" data-mr-source={preset.id} onClick={() => setDraft({ ...preset })}>Edit</button>
            <button type="button" className="mr-link mr-dim" data-mr="PresetRemove" data-mr-source={preset.id} onClick={() => void removePreset(preset)}>Remove</button>
          </>}
          </div>
          {items.length === 0 && prs !== null && !error && <span className="mr-dim" style={{ padding: "4px 8px" }}>Nothing here.</span>}
          {items.map((it, i) => (
            <button key={i} type="button" onClick={() => pick(it)} onMouseEnter={() => setSel(i)}
              className="mr-row" style={{ padding: "8px", border: 0, borderRadius: "var(--mr-radius)", background: i === sel ? "var(--mr-well)" : "transparent", color: "var(--mr-ink)", textAlign: "left", cursor: "pointer", font: "inherit" }}>
              <span className="mr-mono mr-dim" style={{ width: 64, flexShrink: 0 }}>{it.ref}</span>
              <span className="mr-grow mr-ellipsis">{it.title}</span>
              <span style={{ color: it.hot ? "var(--mr-needs-ink)" : "var(--mr-ink-3)", fontWeight: it.hot ? 700 : 400 }}>{it.meta}</span>
            </button>
          ))}
          {askRepo && (
            <div data-mr="AskRepo" className="mr-row" style={{ gap: 10, padding: 10, background: "var(--mr-well)", boxShadow: "inset 4px 0 0 var(--mr-needs)" }}>
              <span className="mr-grow">Where is <b className="mr-mono">{askRepo.slug}</b> cloned on this Mac? It runs there, and it's remembered.</span>
              <FolderPicker value="" onChange={(p) => void useFolderFor(p)} extra={[]} />
            </div>
          )}
          </>}
          {error && <span style={{ color: "var(--mr-error)", padding: "4px 8px" }}>{error}</span>}
        </div>
        <div className="mr-row mr-dim" style={{ padding: "10px 18px", background: "var(--mr-band)" }}>
          <span>{draft ? "↵ save · esc cancel" : `⌘1–${Math.min(9, tiles.length)} switch · ↑↓ pick · ↵ start · esc close`}</span>
          <span className="mr-grow" />
          <span className="mr-ellipsis">{draft ? "Saved for every workspace" : preset ? `Sends your template${preset.worktree ? ", in its own git worktree" : ", in the folder you pick"}` : HOW[mode]}</span>
        </div>
      </div>
    </div>
  );
}

// Adds or edits one of your own kinds (MR-80): a name and the prompt it sends.
function PresetEditor({ draft, onChange, onSave, onCancel }: { draft: Draft; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void }) {
  const ok = draft.name.trim() && draft.template.trim();
  return (
    <form data-mr="PresetEditor" data-mr-source={draft.id ?? "new"} onSubmit={(e) => { e.preventDefault(); onSave(); }}
      style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 8px 4px" }}>
      <span className="mr-dim">{draft.id ? "Edit your kind" : "A new kind of session, next to Blank and Plan"}</span>
      <input autoFocus className="mr-input" placeholder="Name, e.g. Triage" aria-label="Name" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} style={{ background: "var(--mr-well)" }} />
      <input className="mr-input mr-mono" placeholder="Prompt, e.g. /triage {text}  ({text} is what you type)" aria-label="Prompt template" value={draft.template} onChange={(e) => onChange({ ...draft, template: e.target.value })} style={{ background: "var(--mr-well)" }} />
      <div className="mr-row" style={{ gap: 10 }}>
        <label className="mr-row" style={{ gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={draft.worktree} onChange={(e) => onChange({ ...draft, worktree: e.target.checked })} />
          Run in its own git worktree
        </label>
        <span className="mr-grow" />
        <Key k="esc" onClick={onCancel}>Cancel</Key>
        <button type="submit" className="mr-key" data-tone="primary" disabled={!ok}><kbd>↵</kbd>Save</button>
      </div>
    </form>
  );
}
