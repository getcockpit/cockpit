import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../state/store";
import type { Attachment, CommandRow } from "../state/types";
import { matchCommands, typedCommand } from "../picker/slash";
import { insertMention, matchPaths, typedMention } from "../picker/mention";
import { expandPastes, foldsPaste, pasteToken, pastesIn, placeFile, segments } from "../picker/compose";
import { MentionMenu, SlashMenu } from "./SlashMenu";
import { AttachmentRow, notesKey, seedPreview } from "./Attachments";
import { attachmentNotes, clearDrafts, getDrafts } from "./reviewDraft";
import { burnIn } from "./Lightbox";
import { sendsOnEnter, useAutoGrow } from "./autoGrow";
import { keyOf } from "./keys";

// The message box, as in Claude Code and then some (one for a session and the start picker):
// - / lists the session's commands and skills (MR-87), @ files and folders (MR-108);
// - @files, the /command and folded pastes are marked as you type;
// - pasting or dropping an image or PDF attaches it with a thumbnail (Claude sees it at once),
//   any other file by path; the clip button picks files; a long paste folds into a token;
// - ↑ in an empty box brings back what you sent before.

// A folder's files for the @ menu, listed once a minute at most: typing shouldn't re-run git (MR-108).
const pathsCache = new Map<string, { at: number; paths: Promise<string[]> }>();
function folderPaths(cwd: string): Promise<string[]> {
  const hit = pathsCache.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.paths;
  const paths = api.paths(cwd).catch(() => { pathsCache.delete(cwd); return [] as string[]; });
  pathsCache.set(cwd, { at: Date.now(), paths });
  return paths;
}

const toast = (detail: string) => window.dispatchEvent(new CustomEvent("mr:toast", { detail }));

export type PromptBoxHandle = { submit: () => void; focus: () => void; addPaths: (paths: string[]) => void };

type Props = {
  text: string;
  setText: (t: string) => void;
  cwd: string;
  commands: CommandRow[];
  source: string;
  placeholder: string;
  ariaLabel: string;
  /** The message with folded pastes expanded, and its files. */
  onSubmit: (text: string, attachments: Attachment[]) => void;
  /** The / menu opened: the session can be asked for descriptions. */
  onCommands?: () => void;
  /** What you sent before, oldest first: ↑ steps back through it. */
  history?: string[];
  /** Keys none of the box's menus took. */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  menuBelow?: boolean;
  fieldStyle?: CSSProperties;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  autoFocus?: boolean;
  /** Shown at the end of the field's row (the Send button). */
  children?: ReactNode;
};

export const PromptBox = forwardRef<PromptBoxHandle, Props>(function PromptBox(p, handle) {
  const { text, setText, cwd, commands, source } = p;
  const own = useRef<HTMLTextAreaElement>(null);
  const input = p.inputRef ?? own;
  const backdrop = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false); // Esc hides the menu for what's typed now
  const [paths, setPaths] = useState<string[] | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(0);
  const pastes = useRef<Record<number, string>>({});
  const seq = useRef(0);
  const back = useRef<number | null>(null); // where ↑ is in the history
  useAutoGrow(input, text);

  const typed = typedCommand(text);
  const rows = useMemo(() => (typed === null || closed ? [] : matchCommands(commands, typed)), [typed, closed, commands]);
  const mention = typed === null && !closed ? typedMention(text, caret) : null;
  const mentioning = mention !== null;
  useEffect(() => { if (mentioning) void folderPaths(cwd).then(setPaths); }, [mentioning, cwd]);
  const found = useMemo(() => (mention && paths ? matchPaths(paths, mention.query) : []), [mention?.query, mention?.start, paths]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (typed !== null) p.onCommands?.(); }, [typed !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setActive(0); }, [typed, mention?.query]);

  const known = (n: string) => !commands.length || commands.some((c) => c.name === n || c.aliases.includes(n));
  const marks = useMemo(() => segments(text, known), [text, commands]); // eslint-disable-line react-hooks/exhaustive-deps

  // Put text where the caret is (or over the selection), spaced from what's around it.
  const insert = (t: string) => {
    const el = input.current;
    const start = el?.selectionStart ?? text.length, end = el?.selectionEnd ?? start;
    const head = text.slice(0, start), rest = text.slice(end);
    const mid = `${head && !/\s$/.test(head) ? " " : ""}${t}${/^\s/.test(rest) ? "" : " "}`;
    const next = head + mid + rest, at = head.length + mid.length;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(at, at); });
  };

  const attach = (a: Attachment[]) => setFiles((xs) => [...xs, ...a.filter((x) => !xs.some((y) => y.path === x.path))]);

  // Dropped or picked files: images and PDFs attach, the folder's own files are mentioned.
  const addPaths = async (list: string[]) => {
    if (!list.length) return;
    setBusy((n) => n + 1);
    try {
      const info = await api.attachmentInfo(list);
      const mentions: string[] = [], add: Attachment[] = [];
      for (const f of info) {
        if (!f.exists) { toast(`Not found: ${f.path}`); continue; }
        const at = placeFile(f, cwd);
        if (at.as === "mention") mentions.push(at.text);
        else add.push({ path: f.path, name: f.name, mime: f.mime, size: f.size });
      }
      attach(add);
      if (mentions.length) insert(mentions.join(" "));
    } catch (e) { toast(`Can't attach: ${String(e).split("\n")[0]}`); }
    finally { setBusy((n) => n - 1); }
  };

  // Pasted files have no path: their bytes are saved first. A screenshot is called "image.png".
  const addBlobs = async (blobs: File[]) => {
    setBusy((n) => n + 1);
    try {
      const saved = await Promise.all(blobs.map(async (b) => {
        const name = !b.name || b.name === "image.png" ? `Pasted image ${++seq.current}.png` : b.name;
        const a = await api.attachmentSave(b, name);
        if (a.mime.startsWith("image/")) seedPreview(a.path, b);
        return a;
      }));
      attach(saved);
    } catch (e) { toast(`Can't attach: ${String(e).split("\n")[0]}`); }
    finally { setBusy((n) => n - 1); }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    const plain = dt.getData("text/plain");
    // Files copied in Finder come as file:// URLs: keep their real paths.
    const urls = dt.getData("text/uri-list").split(/\r?\n/).filter((l) => l.startsWith("file://"));
    if (urls.length) { e.preventDefault(); void addPaths(urls.map((u) => decodeURIComponent(new URL(u).pathname))); return; }
    const blobs = [...dt.files];
    // Rich copies (a spreadsheet, a web page) carry a picture of the text too: the text wins then.
    if (blobs.length && (!plain.trim() || blobs.some((b) => plain.includes(b.name)))) { e.preventDefault(); void addBlobs(blobs); return; }
    if (plain && foldsPaste(plain)) {
      e.preventDefault();
      const n = ++seq.current;
      pastes.current[n] = plain;
      insert(pasteToken(n, plain));
    }
  };

  // Files dropped on this box (state/fileDrop.ts): handled here instead of as plain @ paths.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const on = (e: Event) => { e.preventDefault(); void addPaths((e as CustomEvent<string[]>).detail); };
    el.addEventListener("mr:files", on);
    return () => el.removeEventListener("mr:files", on);
  });

  const pick = async () => {
    try {
      const got = await open({ multiple: true, directory: false, defaultPath: cwd.startsWith("/") ? cwd : undefined, title: "Attach files" });
      if (got) void addPaths(Array.isArray(got) ? got : [got]);
    } catch (e) { toast(`Can't open the file picker: ${String(e).split("\n")[0]}`); }
  };

  const submit = () => {
    const typed = expandPastes(text, pastes.current).trim();
    if (!typed && !files.length) return;
    if (busy) { toast("Still attaching: one moment"); return; }
    const draftOf = (path: string) => getDrafts(notesKey(path), 1)[0];
    const send = (copies: Record<string, string>, extra: Attachment[]) => {
      // Pins and drawn marks on your own images travel as text after the message (MR-142, MR-143),
      // and a drawn-on copy goes along as one more image.
      const notes = attachmentNotes(files, draftOf, copies);
      files.forEach((f) => clearDrafts(notesKey(f.path)));
      p.onSubmit([typed, notes].filter(Boolean).join("\n\n"), [...files, ...extra]);
      setText(""); setCaret(0); setClosed(false); setFiles([]);
      pastes.current = {};
      back.current = null;
    };
    const drawn = files.filter((f) => draftOf(f.path).ink?.length);
    if (!drawn.length) { send({}, []); return; }
    setBusy((n) => n + 1);
    void Promise.all(drawn.map(async (f) => {
      const b = await burnIn(f.path, draftOf(f.path).ink);
      return b ? { from: f.path, a: await api.attachmentSave(b, `${f.name.replace(/\.[^.]+$/, "")}-drawn.png`) } : null;
    })).then((xs) => {
      const ok = xs.filter((x): x is { from: string; a: Attachment } => !!x);
      send(Object.fromEntries(ok.map((x) => [x.from, x.a.path])), ok.map((x) => x.a));
    }).catch((e) => toast(`Can't add the drawing: ${String(e).split("\n")[0]}`)).finally(() => setBusy((n) => n - 1));
  };
  useImperativeHandle(handle, () => ({ submit, focus: () => input.current?.focus(), addPaths: (l) => void addPaths(l) }));

  const pickPath = (path: string) => {
    if (!mention) return;
    const next = insertMention(text, mention, path);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret));
  };
  const pickCommand = (name: string) => { setText(`/${name} `); setClosed(true); };

  // Expand a folded paste back into the box, to edit it.
  const unfold = (n: number) => {
    const t = pastes.current[n];
    if (t == null) return;
    setText(text.replace(new RegExp(`\\[Pasted text #${n} · \\d+ lines\\]`), () => t));
    delete pastes.current[n];
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const k = keyOf(e.nativeEvent);
    const took = () => { e.preventDefault(); e.stopPropagation(); };
    if (!rows.length && found.length) {
      if (k === "ArrowDown" || k === "ArrowUp") { took(); setActive((i) => (i + (k === "ArrowDown" ? 1 : found.length - 1)) % found.length); return; }
      if (k === "Tab" || k === "Enter") { took(); pickPath(found[active] ?? found[0]); return; }
      if (k === "Escape") { took(); setClosed(true); return; }
    }
    if (rows.length) {
      if (k === "ArrowDown" || k === "ArrowUp") { took(); setActive((i) => (i + (k === "ArrowDown" ? 1 : rows.length - 1)) % rows.length); return; }
      if (k === "Tab") { took(); pickCommand(rows[active].name); return; }
      // ↵ on a row: an exact name runs, anything else completes it first (so arguments can follow).
      if (k === "Enter" && rows[active].name !== typed) { took(); pickCommand(rows[active].name); return; }
      if (k === "Escape") { took(); setClosed(true); return; }
    }
    // ↑ at the start of an empty box (or one showing an earlier message) steps back; ↓ forward.
    const h = p.history ?? [];
    const atStart = e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0;
    const browsing = back.current !== null && text === h[back.current];
    if (k === "ArrowUp" && h.length && (text === "" || (browsing && atStart))) {
      took();
      const i = back.current === null || !browsing ? h.length - 1 : Math.max(0, back.current - 1);
      back.current = i; setText(h[i]);
      return;
    }
    if (k === "ArrowDown" && browsing && e.currentTarget.selectionStart === text.length) {
      took();
      const i = back.current! + 1;
      back.current = i < h.length ? i : null; setText(i < h.length ? h[i] : "");
      return;
    }
    if ((k === "Backspace" || k === "Delete") && !text && files.length) { took(); setFiles((xs) => xs.slice(0, -1)); return; }
    // ↵ with nothing to send is left to the screen (the start picker opens the picked row).
    if (sendsOnEnter(e)) { e.preventDefault(); if (text.trim() || files.length) { e.stopPropagation(); submit(); return; } }
    p.onKeyDown?.(e);
  };

  const folded = pastesIn(text).filter((n) => pastes.current[n] != null);
  const field: CSSProperties = { position: "relative", flex: 1, minWidth: 0, background: (p.fieldStyle?.background as string) ?? "var(--mr-tile)", borderRadius: "var(--mr-radius)" };
  const font: CSSProperties = { fontSize: p.fieldStyle?.fontSize ?? 15 };
  return (
    <div data-mr="PromptBox" data-mr-source={source} style={{ position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
      <SlashMenu rows={rows} active={active} onPick={(r) => pickCommand(r.name)} onHover={setActive} source={source} below={p.menuBelow} />
      {!rows.length && <MentionMenu paths={found} active={active} onPick={pickPath} onHover={setActive} source={source} below={p.menuBelow} />}
      {(files.length > 0 || folded.length > 0 || busy > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--mr-gap)", alignItems: "center" }}>
          <AttachmentRow items={files} onRemove={(a) => { clearDrafts(notesKey(a.path)); setFiles((xs) => xs.filter((x) => x.path !== a.path)); }} />
          {folded.map((n) => (
            <button key={n} type="button" data-mr="PasteChip" data-mr-source={`paste-${n}`} onClick={() => unfold(n)} title={pastes.current[n].slice(0, 600)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 52, padding: "0 10px", border: 0, borderRadius: "var(--mr-radius)", background: "var(--mr-well)", color: "var(--mr-ink)", font: "inherit", fontSize: 13, cursor: "pointer" }}>
              <span className="mr-mono" style={{ padding: "2px 4px", fontSize: 10, background: "var(--mr-ink)", color: "var(--mr-tile)" }}>TEXT</span>
              <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, textAlign: "left" }}>
                <strong>Pasted text #{n}</strong>
                <span className="mr-dim mr-mono" style={{ fontSize: 11 }}>{pastes.current[n].split("\n").length} lines · click to expand</span>
              </span>
            </button>
          ))}
          {busy > 0 && <span className="mr-dim mr-mono" style={{ fontSize: 12 }}>attaching…</span>}
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--mr-gap)", alignItems: "flex-end" }}>
        <div style={field}>
          <div ref={backdrop} aria-hidden="true" data-mr="PromptMarks"
            style={{ ...font, position: "absolute", inset: 0, padding: "10px 12px", lineHeight: 1.4, whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden", color: "transparent", pointerEvents: "none" }}>
            {marks.map((m, i) => m.kind === "plain" ? <span key={i}>{m.text}</span> : <mark key={i} data-mr-mark={m.kind} style={MARK[m.kind]}>{m.text}</mark>)}
            {"​"}
          </div>
          <textarea className="mr-input" rows={1} placeholder={p.placeholder} value={text} ref={input} autoFocus={p.autoFocus}
            style={{ ...p.fieldStyle, ...font, position: "relative", width: "100%", background: "transparent" }}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setClosed(false); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onScroll={(e) => { if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop; }}
            onPaste={onPaste} onKeyDown={onKey}
            aria-label={p.ariaLabel} aria-autocomplete="list" aria-expanded={rows.length > 0 || found.length > 0} />
        </div>
        <button type="button" onClick={() => void pick()} aria-label="Attach files" title="Attach files (or paste, or drop them here)" data-mr="AttachButton" data-mr-source={source}
          style={{ flex: "none", width: 40, height: 40, minHeight: 0, padding: 0, border: 0, borderRadius: "var(--mr-radius)", background: "var(--mr-well)", color: "var(--mr-ink-2)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M12 7.5 6.8 12.7a3 3 0 0 1-4.3-4.2L8 3a2 2 0 0 1 2.8 2.8L5.6 11a1 1 0 0 1-1.4-1.4L9 4.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        {p.children}
      </div>
    </div>
  );
});

// Marks fill behind the text (the box's own text sits on top), so they never shift a letter.
const fill = (c: string): CSSProperties => ({ color: "transparent", background: c, borderRadius: 2, boxShadow: `0 0 0 2px ${c}` });
const MARK: Record<"file" | "command" | "paste", CSSProperties> = {
  file: fill("color-mix(in srgb, var(--mr-selected) 18%, transparent)"),
  command: fill("color-mix(in srgb, var(--mr-ink) 14%, transparent)"),
  paste: fill("var(--mr-well)"),
};
