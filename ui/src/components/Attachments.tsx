import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Attachment } from "../state/types";
import { fileSize } from "../picker/compose";
import { Lightbox, previewOf } from "./Lightbox";
import { getDrafts, setDraft, useDrafts } from "./reviewDraft";

export { seedPreview } from "./Lightbox";

// Pins on your own image, before you send it (MR-142): the message box's lightbox drops them,
// and PromptBox appends them to the message as text.
export const notesKey = (path: string) => `attach:${path}`;

// Files sent with a message, as chips: an image as its thumbnail (click for the full view), any
// other file as its name and size (click to show it in Finder). The message box shows them with ×
// to take them off; your sent message shows them under its text.

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
  useDrafts();
  const url = usePreview(a);
  const [open, setOpen] = useState(false);
  const pins = onRemove ? getDrafts(notesKey(a.path), 1)[0].pins.length : 0;
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
      {pins > 0 && <span className="mr-mono" title="Pinned notes go with the message" style={{ position: "absolute", bottom: 2, left: 2, padding: "0 4px", fontSize: 10, fontWeight: 700, background: "var(--mr-needs)" }}>{pins} pin{pins === 1 ? "" : "s"}</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`} title="Remove"
          style={{ position: "absolute", top: 2, right: 2, width: 20, height: 20, minHeight: 0, padding: 0, border: 0, borderRadius: "var(--mr-radius)", background: "var(--mr-ink)", color: "var(--mr-tile)", font: "inherit", fontSize: 12, lineHeight: "20px", cursor: "pointer" }}>×</button>
      )}
      {open && url && (onRemove
        ? <Lightbox images={[{ path: a.path, name: a.name }]} ask={{ verdict: false, pins: true }} drafts={getDrafts(notesKey(a.path), 1)} onDraft={(_, p) => setDraft(notesKey(a.path), 0, p)} onClose={() => setOpen(false)} />
        : <Lightbox images={[{ path: a.path, name: a.name }]} onClose={() => setOpen(false)} />)}
    </span>
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
