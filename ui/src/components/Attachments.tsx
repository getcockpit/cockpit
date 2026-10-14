import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../state/store";
import type { Attachment } from "../state/types";
import { fileSize } from "../picker/compose";
import { keyOf } from "./keys";

// Files sent with a message, as chips: an image as its thumbnail (click for the full view), any
// other file as its name and size (click to show it in Finder). The message box shows them with ×
// to take them off; your sent message shows them under its text.

// Thumbnails per path: a pasted image seeds its own (it's already in memory), the rest load once.
const urls = new Map<string, Promise<string | null>>();
export function seedPreview(path: string, blob: Blob) {
  urls.set(path, Promise.resolve(URL.createObjectURL(blob)));
}
function previewOf(path: string): Promise<string | null> {
  let u = urls.get(path);
  if (!u) {
    u = api.attachmentRead(path).then((b) => URL.createObjectURL(new Blob([b]))).catch(() => null);
    urls.set(path, u);
  }
  return u;
}

const isImage = (a: Attachment) => a.mime.startsWith("image/") && a.mime !== "image/heic";

function usePreview(a: Attachment): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage(a)) return;
    let live = true;
    void previewOf(a.path).then((u) => live && setUrl(u));
    return () => { live = false; };
  }, [a.path]); // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}

function reveal(a: Attachment, session?: string) {
  invoke("file_reveal", { session: session ?? null, cwd: "/", path: a.path }).catch((e) => {
    window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Can't show it: ${String(e).split("\n")[0]}` }));
  });
}

/** One attachment. `onRemove` adds the × (the message box); without it the chip is read-only (the transcript). */
export function AttachmentChip({ a, onRemove, session, big }: { a: Attachment; onRemove?: () => void; session?: string; big?: boolean }) {
  const url = usePreview(a);
  const [open, setOpen] = useState(false);
  const h = big ? 96 : 52;
  const kind = a.mime === "application/pdf" ? "PDF" : isImage(a) ? "image" : (a.name.split(".").pop() ?? "file").slice(0, 5).toUpperCase();
  return (
    <span data-mr="AttachmentChip" data-mr-source={a.path} title={a.path}
      style={{ position: "relative", display: "inline-flex", alignItems: "stretch", maxWidth: 260, background: "var(--mr-well)", borderRadius: "var(--mr-radius)", overflow: "hidden" }}>
      <button type="button" onClick={() => (url ? setOpen(true) : reveal(a, session))} aria-label={url ? `View ${a.name}` : `Show ${a.name} in Finder`}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, padding: url ? 0 : "0 10px", paddingRight: onRemove ? 26 : url ? 0 : 10, height: h, border: 0, background: "transparent", color: "var(--mr-ink)", font: "inherit", cursor: "pointer", textAlign: "left" }}>
        {url
          ? <img src={url} alt="" style={{ height: h, maxWidth: big ? 220 : 120, objectFit: "cover", display: "block" }} />
          : <>
              <span className="mr-mono" style={{ flex: "none", padding: "2px 4px", fontSize: 10, background: "var(--mr-ink)", color: "var(--mr-tile)" }}>{kind}</span>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, lineHeight: 1.2 }}>
                <span className="mr-ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</span>
                {a.size != null && <span className="mr-dim mr-mono" style={{ fontSize: 11 }}>{fileSize(a.size)}</span>}
              </span>
            </>}
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`} title="Remove"
          style={{ position: "absolute", top: 2, right: 2, width: 20, height: 20, minHeight: 0, padding: 0, border: 0, borderRadius: "var(--mr-radius)", background: "var(--mr-ink)", color: "var(--mr-tile)", font: "inherit", fontSize: 12, lineHeight: "20px", cursor: "pointer" }}>×</button>
      )}
      {open && url && createPortal(<ImageView url={url} a={a} onClose={() => setOpen(false)} />, document.body)}
    </span>
  );
}

// The image at full size over everything; Esc or a click closes it.
function ImageView({ url, a, onClose }: { url: string; a: Attachment; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (keyOf(e) === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={a.name} data-mr="ImageView" data-mr-source={a.path} onMouseDown={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 30, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 40, background: "rgba(21,24,27,.6)" }}>
      <img src={url} alt={a.name} style={{ maxWidth: "100%", maxHeight: "calc(100% - 40px)", objectFit: "contain", background: "var(--mr-tile)" }} />
      <span className="mr-mono" style={{ color: "var(--mr-tile)", fontSize: 12 }}>{a.name}{a.size != null && ` · ${fileSize(a.size)}`} · Esc to close</span>
    </div>
  );
}

/** A row of attachments. */
export function AttachmentRow({ items, onRemove, session, big }: { items: Attachment[]; onRemove?: (a: Attachment) => void; session?: string; big?: boolean }) {
  if (!items.length) return null;
  return (
    <div data-mr="AttachmentRow" style={{ display: "flex", flexWrap: "wrap", gap: "var(--mr-gap)" }}>
      {items.map((a) => <AttachmentChip key={a.path} a={a} session={session} big={big} onRemove={onRemove && (() => onRemove(a))} />)}
    </div>
  );
}
