import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { replay } from "../state/reduce";
import type { MrEvent } from "../state/types";
import { countLabels, LAMP, lamps, Overview } from "./Overview";
import type { OverviewArea, OverviewBlock } from "../state/overview";

const block = (id: string, needs = false): OverviewBlock => ({ kind: "session", id, title: id, lamp: needs ? "needs_you" : "working", needs, status: "", step: null });

describe("Overview labels (decision 40)", () => {
  const c = { needs: 1, resume: 2, progress: 0, review: 3 };
  it("hides zero counts and spells the rest out up close", () => {
    expect(countLabels(c).map((l) => l.text)).toEqual(["⚠ 1 needs you", "↻ 2 resume", "◇ 3 review"]);
  });
  it("zoomed out, drops the words but never on what needs you, and keeps them as a tooltip", () => {
    const short = countLabels(c, true);
    expect(short.map((l) => l.text)).toEqual(["⚠ 1 needs you", "↻ 2", "◇ 3"]);
    expect(short.map((l) => l.title)).toEqual(["1 needs you", "2 resume", "3 review"]);
    expect(countLabels({ ...c, needs: 2 })[0].text).toBe("⚠ 2 need you");
  });
  it("the far view's lamp strip shows every open item, what needs you first", () => {
    const a = { groups: { resume: [block("r")], progress: [block("p"), block("ask", true)], review: [block("v")] } } as unknown as OverviewArea;
    expect(lamps(a).map((b) => b.id)).toEqual(["ask", "r", "p", "v"]);
  });
});

describe("Overview lamps", () => {
  it("every tile state draws a visible lamp, never the pale off grey", () => {
    const states = ["needs_you", "working", "almost", "idle", "review", "done", "error", "starting", "interrupted"] as const;
    for (const st of states) expect(LAMP[st]).toMatch(/^var\(--mr-(?!lamp-off)/);
  });
});

describe("Overview render", () => {
  let n = 0;
  const ev = (kind: string, payload: Record<string, unknown>, session: string | null = null): MrEvent => ({ id: `E${String(++n).padStart(5, "0")}`, session_id: session, kind, payload, anchor: null, created_at: n });
  const state = replay([
    ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" }),
    ev("ui.session_requested", { prompt: "Fix the login redirect loop on Safari after the OAuth callback", cwd: "/w", workspace: "ws_b" }, "s1"),
    ev("sidecar.session_started", { sdk_session_id: "sdk", model: "m" }, "s1"),
  ]);
  const html = renderToStaticMarkup(<Overview state={state} docs={[]} fitSignal={0} onBack={() => {}} onOpenWorkspace={() => {}} onOpenSession={() => {}} onOpenDoc={() => {}} />);
  it("draws a rectangle per workspace, with an empty one saying so", () => {
    expect(html.match(/data-mr="OverviewArea"/g)).toHaveLength(2);
    expect(html).toContain("Nothing open");
  });
  it("gives every block its full title as a tooltip, since the tile truncates it", () => {
    expect(html).toMatch(/data-mr="OverviewBlock"[^>]*title="Fix the login redirect loop on Safari/);
  });
  it("has no button inside a block: the map is read-only", () => {
    const blocks = html.split('data-mr="OverviewBlock"').slice(1).map((b) => b.slice(0, b.indexOf("</button>")));
    expect(blocks.length).toBe(1);
    for (const b of blocks) expect(b).not.toContain("<button");
  });
  it("every zoom control is a labelled button", () => {
    for (const l of ["Zoom out", "Zoom in", "Zoom to 100%"]) expect(html).toContain(`aria-label="${l}"`);
    expect(html).toContain(`data-mr="OverviewBar"`); // its own band: the map never shows through it
  });
});
