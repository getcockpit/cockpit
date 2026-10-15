import { pickTile, type TileSpec } from "../picker/pick";
import { sessionTitle } from "../picker/title";
import { needsQueue } from "../picker/queue";
import { docStage, isBrief, isOpenQuestion, STAGE_LABEL, type Doc } from "./docs";
import type { AppState, SessionState } from "./types";

// The Overview (decision 40, MR-155): every workspace as one rectangle on a free canvas, every open
// session and doc as its own block inside it. A read-only map: what needs you is a count beside the
// workspace name and an amber lamp, never a question or a button. Done work isn't on it.

export type OverviewGroup = "resume" | "progress" | "review";
export const GROUPS: OverviewGroup[] = ["resume", "progress", "review"];
export const GROUP_LABEL: Record<OverviewGroup, string> = { resume: "Resume", progress: "In progress", review: "Review" };

export type OverviewBlock = {
  kind: "session" | "doc";
  id: string;
  title: string;
  lamp: TileSpec["state"]; // the Wall's state mark: amber when it needs you
  needs: boolean;
  status: string; // one line, shown at close zoom
  step: string | null; // the plan step in progress, if any (close zoom)
};

export type Counts = { needs: number; resume: number; progress: number; review: number };

export type OverviewArea = {
  workspace: string;
  name: string;
  index: number; // tab position, for the ⌘n key
  folder: string | null;
  counts: Counts;
  groups: Record<OverviewGroup, OverviewBlock[]>;
  x: number; y: number; w: number; h: number;
};

export type Layout = Record<string, { x: number; y: number }>;

// Canvas units (CSS px at zoom 1). Heights are computed, not measured, so layout is pure and testable.
export const AREA_W = 720, HEADER_H = 64, LABEL_H = 28, BLOCK_H = 64, BLOCK_GAP = 8, PAD = 16, AREA_GAP = 80;
export const COL_W = (AREA_W - PAD * 2 - BLOCK_GAP * 2) / 3;

const step = (s: SessionState) => { const t = s.todos.find((x) => x.status === "in_progress") ?? s.todos.find((x) => x.status === "pending"); return t ? t.activeForm || t.content : null; };

// The block's one line. Never the question itself (the map is read-only): that's read inside the workspace.
function status(s: SessionState, tile: TileSpec): string {
  if (tile.state === "needs_you") return "Needs you";
  if (s.status === "error") return "Stopped with an error";
  if (s.status === "interrupted") return "Interrupted";
  if (s.status === "ended") { const open = s.todos.filter((t) => t.status !== "completed").length; return `Ended with ${open} step${open === 1 ? "" : "s"} open`; }
  return tile.state === "review" || tile.state === "idle" ? tile.step : tile.doing;
}

/** Where an open session belongs, or null once it's done (ended cleanly with its plan finished). */
export function sessionGroup(s: SessionState, tile: TileSpec = pickTile(s)): OverviewGroup | null {
  if (s.archivedAt || s.fromDeleted) return null;
  if (tile.state === "needs_you") return "progress";
  if (s.status === "interrupted" || s.status === "error") return "resume";
  if (s.status === "ended") return s.todos.some((t) => t.status !== "completed") ? "resume" : null;
  if (tile.state === "review") return "review";
  return "progress";
}

/** Where a doc belongs: ready and shipped ones wait for your review, the rest are in progress. Briefs have no place. */
export function docGroup(d: Doc, sessions: Record<string, SessionState>): OverviewGroup | null {
  if (isBrief(d)) return null;
  if (d.session_id && sessions[d.session_id]?.archivedAt) return null;
  const st = docStage(d, sessions);
  return st === "ready" || st === "shipped" ? "review" : "progress";
}

/** Docs that belong to a workspace: through the session that wrote them, else Personal (as App.tsx scopes them). */
export const docsIn = (docs: Doc[], sessions: Record<string, SessionState>, ws: string) =>
  docs.filter((d) => (d.session_id ? sessions[d.session_id]?.workspace === ws : ws === "personal"));

/** The columns a workspace draws: only groups with something in them, sharing the width, so a lone
 *  busy group gets room for its titles instead of a third of it beside two empty headings. */
export function columns(groups: Record<OverviewGroup, OverviewBlock[]>): { group: OverviewGroup; x: number; w: number }[] {
  const used = GROUPS.filter((g) => groups[g].length);
  const w = (AREA_W - PAD * 2 - BLOCK_GAP * (used.length - 1)) / Math.max(1, used.length);
  return used.map((group, i) => ({ group, x: PAD + i * (w + BLOCK_GAP), w }));
}

/** A column shows at most this many rows; past that the last row says "+N more" (one busy workspace
 *  shouldn't stretch the whole grid and push its neighbours out of a fit). */
export const MAX_ROWS = 6;
export function shown(blocks: OverviewBlock[]): { blocks: OverviewBlock[]; more: number } {
  if (blocks.length <= MAX_ROWS) return { blocks, more: 0 };
  return { blocks: blocks.slice(0, MAX_ROWS - 1), more: blocks.length - (MAX_ROWS - 1) };
}

export function areaHeight(groups: Record<OverviewGroup, OverviewBlock[]>): number {
  const rows = Math.min(MAX_ROWS, Math.max(1, ...GROUPS.map((g) => groups[g].length)));
  return HEADER_H + LABEL_H + rows * (BLOCK_H + BLOCK_GAP) + PAD;
}

/** Remembered spots first. Workspaces without one are packed as a grid to the right of them, with as
 *  many columns as make the whole grid largest in a viewport of this aspect (width / height). */
export function place(sizes: { workspace: string; w: number; h: number }[], layout: Layout, aspect = 16 / 10): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  let right = -AREA_GAP;
  for (const s of sizes) { const p = layout[s.workspace]; if (p) { out[s.workspace] = p; right = Math.max(right, p.x + s.w); } }
  const top = Object.values(out).reduce((m, p) => Math.min(m, p.y), Infinity);
  const free = sizes.filter((s) => !out[s.workspace]);
  if (!free.length) return out;
  const x0 = right + AREA_GAP, y0 = Number.isFinite(top) ? top : 0;
  const rows = (cols: number) => Array.from({ length: Math.ceil(free.length / cols) }, (_, r) => free.slice(r * cols, r * cols + cols));
  const size = (cols: number) => {
    const rs = rows(cols);
    return { w: Math.max(...rs.map((r) => r.reduce((t, s) => t + s.w, 0) + (r.length - 1) * AREA_GAP)), h: rs.reduce((t, r) => t + Math.max(...r.map((s) => s.h)), 0) + (rs.length - 1) * AREA_GAP };
  };
  // The scale the grid would get in the viewport; the widest grid wins a tie (fewer rows to scan).
  let best = 1, bestScale = 0;
  for (let cols = 1; cols <= free.length; cols++) { const g = size(cols); const k = Math.min(aspect / g.w, 1 / g.h); if (k >= bestScale) { best = cols; bestScale = k; } }
  let y = y0;
  for (const r of rows(best)) {
    let x = x0;
    for (const s of r) { out[s.workspace] = { x, y }; x += s.w + AREA_GAP; }
    y += Math.max(...r.map((s) => s.h)) + AREA_GAP;
  }
  return out;
}

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Where a dropped rectangle lands: where you let go, unless that covers another workspace; then the
 *  nearest spot beside one of them that covers nothing (a map you can't read under a pile is no map),
 *  preferring spots inside `view` (the visible canvas) so it never lands out of sight. */
export function settle(drop: Rect, others: Rect[], view?: Rect, gap = AREA_GAP / 2): { x: number; y: number } {
  const free = (r: Rect) => !others.some((o) => overlaps(r, o, gap - 1));
  if (free(drop)) return { x: drop.x, y: drop.y };
  const spots: { x: number; y: number }[] = [];
  for (const o of others) {
    spots.push({ x: o.x - drop.w - gap, y: drop.y }, { x: o.x + o.w + gap, y: drop.y }, { x: drop.x, y: o.y - drop.h - gap }, { x: drop.x, y: o.y + o.h + gap });
  }
  const seen = (p: { x: number; y: number }) => !view || (p.x >= view.x && p.y >= view.y && p.x + drop.w <= view.x + view.w && p.y + drop.h <= view.y + view.h);
  const dist = (p: { x: number; y: number }) => Math.hypot(p.x - drop.x, p.y - drop.y);
  const ok = spots.filter((p) => free({ ...drop, ...p })).sort((a, b) => Number(seen(b)) - Number(seen(a)) || dist(a) - dist(b));
  if (ok.length) return ok[0];
  // Boxed in on every side: below everything.
  return { x: drop.x, y: Math.max(...others.map((o) => o.y + o.h)) + gap };
}

export function overview(state: Pick<AppState, "sessions" | "workspaces">, docs: Doc[], layout: Layout, aspect?: number): OverviewArea[] {
  const built = state.workspaces.map((w, index) => {
    const sessions = Object.values(state.sessions).filter((s) => s.workspace === w.id);
    const wsDocs = docsIn(docs, state.sessions, w.id);
    const groups: Record<OverviewGroup, OverviewBlock[]> = { resume: [], progress: [], review: [] };
    for (const s of sessions) {
      const tile = pickTile(s);
      const g = sessionGroup(s, tile);
      if (!g) continue;
      const needs = tile.state === "needs_you";
      // Ended with steps still open isn't done: it shows as stopped, like an interrupted one.
      const lamp = s.status === "ended" && !needs ? "interrupted" : tile.state;
      groups[g].push({ kind: "session", id: s.id, title: sessionTitle(s), lamp, needs, status: status(s, tile), step: step(s) });
    }
    for (const d of wsDocs) {
      const g = docGroup(d, state.sessions);
      if (!g) continue;
      const open = Object.values(d.blocks).filter(isOpenQuestion).length;
      const st = docStage(d, state.sessions);
      groups[g].push({ kind: "doc", id: d.id, title: d.title, lamp: open ? "needs_you" : g === "review" ? "review" : "working", needs: open > 0, status: open ? `${open} open question${open === 1 ? "" : "s"}` : STAGE_LABEL[st], step: null });
    }
    // Anything waiting on you goes first in its group; otherwise the order things started in.
    for (const g of GROUPS) groups[g].sort((a, b) => Number(b.needs) - Number(a.needs));
    const counts: Counts = { needs: needsQueue(sessions, wsDocs).length, resume: groups.resume.length, progress: groups.progress.length, review: groups.review.length };
    return { workspace: w.id, name: w.name, index, folder: w.folder, counts, groups, w: AREA_W, h: areaHeight(groups) };
  });
  const at = place(built, layout, aspect);
  return built.map((a) => ({ ...a, ...at[a.workspace] }));
}

/** The rectangle closest to a canvas point (0 if it's inside one), for zooming to 100% onto something. */
export function nearest<T extends Rect>(areas: T[], px: number, py: number): T | null {
  const d = (a: Rect) => Math.hypot(Math.max(a.x - px, 0, px - (a.x + a.w)), Math.max(a.y - py, 0, py - (a.y + a.h)));
  return areas.reduce<T | null>((best, a) => (!best || d(a) < d(best) ? a : best), null);
}

/** 100% onto a rectangle: centred across, and down too if it fits; a taller one shows from its top. */
export function actualSize(a: Rect, view: { w: number; h: number }, margin = 24): { x: number; y: number; zoom: number } {
  return { zoom: 1, x: (view.w - a.w) / 2 - a.x, y: a.h + margin * 2 <= view.h ? (view.h - a.h) / 2 - a.y : margin - a.y };
}

/** How far to pan (screen px) so a canvas rectangle is in view with a margin; 0, 0 when it already is.
 *  `view` is the visible screen box (the canvas minus the bottom bar). */
export function revealBy(r: Rect, cam: { x: number; y: number; zoom: number }, view: { w: number; h: number }, m = 24): { dx: number; dy: number } {
  const L = r.x * cam.zoom + cam.x, T = r.y * cam.zoom + cam.y, R = L + r.w * cam.zoom, B = T + r.h * cam.zoom;
  // Too big to fit: show its top-left corner.
  const axis = (lo: number, hi: number, size: number) => (lo < m ? m - lo : hi > size - m ? Math.max(size - m - hi, m - lo) : 0);
  return { dx: axis(L, R, view.w), dy: axis(T, B, view.h) };
}

/** Whether any rectangle shows in the visible screen box (panned off into empty canvas, none does). */
export function anyInView(areas: Rect[], cam: { x: number; y: number; zoom: number }, view: { w: number; h: number }): boolean {
  return areas.some((r) => { const L = r.x * cam.zoom + cam.x, T = r.y * cam.zoom + cam.y; return L < view.w && L + r.w * cam.zoom > 0 && T < view.h && T + r.h * cam.zoom > 0; });
}

/** The box around every area, for ⌘0 fit-all. */
export function bounds(areas: Pick<OverviewArea, "x" | "y" | "w" | "h">[]): { x: number; y: number; w: number; h: number } {
  if (!areas.length) return { x: 0, y: 0, w: AREA_W, h: HEADER_H };
  const x = Math.min(...areas.map((a) => a.x)), y = Math.min(...areas.map((a) => a.y));
  return { x, y, w: Math.max(...areas.map((a) => a.x + a.w)) - x, h: Math.max(...areas.map((a) => a.y + a.h)) - y };
}

/** Zoom that fits a box in a viewport with a margin, capped so a lone workspace isn't blown up. */
export function fit(box: { x: number; y: number; w: number; h: number }, view: { w: number; h: number }, margin = 48): { x: number; y: number; zoom: number } {
  const zoom = Math.max(MIN_ZOOM, Math.min(1, (view.w - margin * 2) / box.w, (view.h - margin * 2) / box.h));
  return { zoom, x: (view.w - box.w * zoom) / 2 - box.x * zoom, y: (view.h - box.h * zoom) / 2 - box.y * zoom };
}

export const MIN_ZOOM = 0.15, MAX_ZOOM = 2;
/** Semantic zoom: far shows names and counts, middle a lamp and title per block, close adds status and plan step. */
export const detail = (zoom: number): "far" | "middle" | "close" => (zoom < 0.45 ? "far" : zoom < 0.9 ? "middle" : "close");

/** A font size in canvas px that never reads smaller than `min` screen px: zoomed out, text grows
 *  against the zoom (up to `cap` times its size) instead of shrinking into an unreadable smear. */
export const readable = (size: number, zoom: number, min = 12, cap = 4) => Math.min(size * cap, Math.max(size, min / zoom));

/** Zoom around a point (the cursor) so what's under it stays put. */
export function zoomAt(cam: { x: number; y: number; zoom: number }, px: number, py: number, factor: number) {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  const k = zoom / cam.zoom;
  return { zoom, x: px - (px - cam.x) * k, y: py - (py - cam.y) * k };
}
