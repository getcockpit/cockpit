import { useContext, useState } from "react";
import { Key } from ".";
import { FileContext } from "./FileChip";
import { inline } from "./Markdown";
import { Lightbox, VerdictTag, saveDrawn, useImageSrc, type LbImage } from "./Lightbox";
import { askOf, clearDrafts, compareReply, getDrafts, hasInput, isSent, markSent, marked, nameOf, resolvePath, reviewReply, setDraft, useDrafts, type Draft } from "./reviewDraft";
import type { ViewBlock } from "../state/types";

// The image blocks of the catalog (MR-142): `images`, a gallery Claude shows for review, and
// `image_compare`, a before/after. Verdicts, comments and pins stay a draft until Send review,
// which goes back to Claude as one reply.

const str = (v: unknown) => (typeof v === "string" ? v : "");
const card = { padding: "12px 16px", background: "var(--mr-tile)" } as const;

function Thumb({ im, d, onOpen, pending, h = 120 }: { im: LbImage; d: Draft; onOpen: () => void; pending: boolean; h?: number }) {
  const src = useImageSrc(im.path);
  return (
    <button type="button" data-mr="ImageThumb" data-mr-source={im.path} onClick={onOpen} title={im.path} aria-label={`Open ${im.name}`}
      style={{ display: "flex", flexDirection: "column", gap: 4, padding: 0, border: 0, background: "transparent", font: "inherit", color: "var(--mr-ink)", textAlign: "left", cursor: "zoom-in", minWidth: 0,
        boxShadow: d.verdict === "approve" ? "inset 0 -3px 0 var(--mr-done)" : d.verdict === "reject" ? "inset 0 -3px 0 var(--mr-error)" : undefined }}>
      <span style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", height: h, background: "var(--mr-well)", overflow: "hidden" }}>
        {src ? <img src={src} alt="" draggable={false} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }} />
          : <span className="mr-dim mr-mono" style={{ fontSize: 11, padding: 8 }}>{src === null ? `Can't load ${im.name}` : "loading…"}</span>}
        {marked(d) > 0 && <span className="mr-mono" style={{ position: "absolute", top: 4, right: 4, padding: "0 6px", fontSize: 11, fontWeight: 700, background: "var(--mr-needs)" }}>{marked(d)} mark{marked(d) === 1 ? "" : "s"}</span>}
      </span>
      <span className="mr-ellipsis" style={{ fontSize: 12, fontWeight: 600 }}>{im.caption ? inline(im.caption) : im.name}</span>
      <VerdictTag d={d} pending={pending} />
    </button>
  );
}

// Drawn-on copies for every image with marks (MR-143, MR-145), saved before the reply goes.
const copiesFor = (images: LbImage[], drafts: Draft[]) => Promise.all(images.map((im, i) => (drafts[i]?.ink?.length ? saveDrawn(im.path, im.name, drafts[i].ink) : undefined)));

function SendRow({ live, sent, ready, count, onSend, onClear }: { live: boolean; sent: boolean; ready: boolean; count: string; onSend: () => Promise<void>; onClear: () => void }) {
  const [sending, setSending] = useState(false);
  if (sent) return <span className="mr-dim" style={{ fontSize: 12 }}>Review sent to Claude.</span>;
  if (!live) return null;
  return (
    <div className="mr-row" style={{ gap: 8 }}>
      <span className="mr-dim mr-grow" style={{ fontSize: 12 }}>{count}</span>
      {ready && <Key onClick={onClear}>Clear</Key>}
      <Key tone="primary" disabled={!ready || sending} onClick={() => { setSending(true); void onSend().finally(() => setSending(false)); }}>{sending ? "Sending…" : "Send review"}</Key>
    </div>
  );
}

/** images {items: [{path, caption?}], ask?}: a gallery; click opens the lightbox. */
export function ImageGallery({ b, src, onReply, live }: { b: ViewBlock; src: string; onReply: (t: string) => void; live: boolean }) {
  useDrafts();
  const cwd = useContext(FileContext)?.cwd;
  const [open, setOpen] = useState<number | null>(null);
  const items = (Array.isArray(b.items) ? b.items : []).map((x) => (typeof x === "string" ? { path: x } : (x as Record<string, unknown>)))
    .map((x) => ({ path: resolvePath(str(x.path), cwd), caption: str(x.caption) || undefined })).filter((x) => x.path);
  const ask = askOf(b.ask);
  const asking = live && (ask.verdict || ask.pins);
  const drafts = getDrafts(src, items.length);
  const sent = isSent(src);
  const images: LbImage[] = items.map((x) => ({ ...x, name: nameOf(x.path) }));
  const decided = drafts.filter((d) => d.verdict).length;
  const pins = drafts.reduce((a, d) => a + marked(d), 0);
  const draft = (i: number, patch: Partial<Draft>) => {
    setDraft(src, i, patch);
    // One image, verdict only: the verdict is the whole review, so it sends at once.
    if (items.length === 1 && ask.verdict && !ask.pins && patch.verdict) { markSent(src); setOpen(null); onReply(reviewReply(items, getDrafts(src, 1))); }
  };
  const send = async () => { const copies = await copiesFor(images, drafts); markSent(src); onReply(reviewReply(items, drafts, copies)); };
  const one = items.length === 1;
  return (
    <section data-mr="ImageGallery" data-mr-source={src} style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: one ? "minmax(0, 1fr)" : "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
        {images.map((im, i) => <Thumb key={i} im={im} d={drafts[i]} pending={asking && !sent && ask.verdict} h={one ? 280 : 120} onOpen={() => setOpen(i)} />)}
      </div>
      {asking && <SendRow live={live} sent={sent} ready={hasInput(drafts)} onSend={send} onClear={() => clearDrafts(src)}
        count={`${ask.verdict ? `${decided} of ${items.length} decided` : ""}${ask.verdict && ask.pins ? " · " : ""}${ask.pins ? `${pins} mark${pins === 1 ? "" : "s"}` : ""} · open an image to judge it`} />}
      {!asking && sent && <span className="mr-dim" style={{ fontSize: 12 }}>Review sent to Claude.</span>}
      {open !== null && <Lightbox images={images} start={open} ask={asking && !sent ? ask : { verdict: false, pins: false }} drafts={drafts} onDraft={draft} onClose={() => setOpen(null)} source={src} />}
    </section>
  );
}

function side(v: unknown, cwd?: string): LbImage & { label: string } {
  const o = typeof v === "string" ? { path: v } : ((v ?? {}) as Record<string, unknown>);
  const path = resolvePath(str(o.path), cwd);
  return { path, name: nameOf(path), label: str(o.label), caption: str(o.label) || undefined };
}

/** image_compare {before, after, ask?}: side by side, or one over the other under a slider. */
export function ImageCompare({ b, src, onReply, live }: { b: ViewBlock; src: string; onReply: (t: string) => void; live: boolean }) {
  useDrafts();
  const cwd = useContext(FileContext)?.cwd;
  const before = side(b.before, cwd), after = side(b.after, cwd);
  const [mode, setMode] = useState<"side" | "slider">("side");
  const [at, setAt] = useState(50);
  const [open, setOpen] = useState<number | null>(null);
  const bs = useImageSrc(before.path), as = useImageSrc(after.path);
  const ask = askOf(b.ask);
  const asking = live && (ask.verdict || ask.pins);
  const drafts = getDrafts(src, 2); // 0: before (pins only), 1: after (verdict, comment, pins)
  const d = drafts[1];
  const sent = isSent(src);
  const send = async () => { const copies = await copiesFor([before, after], drafts); markSent(src); onReply(compareReply(before.path, after.path, d, drafts[0], copies)); };
  const label = (x: { label: string }, fallback: string) => <span className="mr-dim" style={{ fontSize: 12, fontWeight: 700 }}>{x.label || fallback}</span>;
  const pane = (u: string | null | undefined, x: LbImage, k: number) => (
    <button type="button" onClick={() => setOpen(k)} aria-label={`Open ${x.name}`} title={x.path}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 260, padding: 0, border: 0, background: "var(--mr-well)", cursor: "zoom-in", overflow: "hidden" }}>
      {u ? <img src={u} alt="" draggable={false} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : <span className="mr-dim mr-mono" style={{ fontSize: 11 }}>{u === null ? `Can't load ${x.name}` : "loading…"}</span>}
    </button>
  );
  return (
    <section data-mr="ImageCompare" data-mr-source={src} style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="mr-row" style={{ gap: 6 }}>
        <span className="mr-grow" />
        <Key pressed={mode === "side"} onClick={() => setMode("side")}>Side by side</Key>
        <Key pressed={mode === "slider"} onClick={() => setMode("slider")}>Slider</Key>
      </div>
      {mode === "side" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>{label(before, "Before")}{pane(bs, before, 0)}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>{label(after, "After")}{pane(as, after, 1)}</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="mr-row">{label(before, "Before")}<span className="mr-grow" />{label(after, "After")}</div>
          <div style={{ display: "flex", justifyContent: "center", background: "var(--mr-well)" }}>
          <div style={{ position: "relative", lineHeight: 0 }}>
            {as && <img src={as} alt={after.name} draggable={false} style={{ maxWidth: "100%", maxHeight: 360, display: "block" }} />}
            {bs && <img src={bs} alt={before.name} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill", clipPath: `inset(0 ${100 - at}% 0 0)` }} />}
            <span aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: `${at}%`, borderLeft: "2px solid var(--mr-selected)" }} />
          </div>
          </div>
          <input type="range" min={0} max={100} value={at} onChange={(e) => setAt(Number(e.target.value))} aria-label="Before / after" style={{ accentColor: "var(--mr-selected)" }} />
        </div>
      )}
      {asking && !sent && ask.verdict && (
        <div className="mr-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Key pressed={d.verdict === "approve"} onClick={() => setDraft(src, 1, { verdict: d.verdict === "approve" ? undefined : "approve" })}>Approve</Key>
          <Key pressed={d.verdict === "reject"} onClick={() => setDraft(src, 1, { verdict: d.verdict === "reject" ? undefined : "reject" })}>Reject</Key>
          <input value={d.comment ?? ""} onChange={(e) => setDraft(src, 1, { comment: e.target.value })} placeholder="Comment"
            style={{ flex: 1, minWidth: 160, font: "inherit", padding: "4px 8px", border: 0, background: "var(--mr-well)", color: "var(--mr-ink)" }} />
        </div>
      )}
      {asking && <SendRow live={live} sent={sent} ready={hasInput(drafts)} onSend={send} onClear={() => clearDrafts(src)}
        count={`${d.verdict ? "Decided" : "Not decided yet"}${marked(drafts[0]) + marked(d) ? ` · ${marked(drafts[0]) + marked(d)} marks` : ""} · open an image to pin or draw`} />}
      {open !== null && <Lightbox images={[before, after]} start={open} ask={asking && !sent ? { verdict: false, pins: ask.pins } : { verdict: false, pins: false }} drafts={drafts} onDraft={(i, p) => setDraft(src, i, p)} onClose={() => setOpen(null)} source={src} />}
    </section>
  );
}
