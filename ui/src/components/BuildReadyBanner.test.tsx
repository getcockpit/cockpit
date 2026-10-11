import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { replay } from "../state/reduce";
import type { MrEvent } from "../state/types";
import { BuildReadyBanner } from "./BuildReadyBanner";

// User ask: "after the build is done in the background it should suggest to apply or run it immediately".
const ev = (id: string, kind: string, payload: Record<string, unknown>, at = 1): MrEvent => ({ id, session_id: null, kind, payload, anchor: null, created_at: at });
const started = ev("B1", "selfbuild.started", { build_id: "b1", branch: "mine", sha: "6248e95" });

test("a finished background build offers to relaunch into it until you do or say later", () => {
  expect(renderToStaticMarkup(<BuildReadyBanner all={replay([started])} />)).toBe("");
  const ready = replay([started, ev("B2", "selfbuild.finished", { build_id: "b1", ok: true }, 5)]);
  const html = renderToStaticMarkup(<BuildReadyBanner all={ready} />);
  expect(html).toContain("Build ready");
  expect(html).toContain("mine · 6248e95");
  expect(html).toContain("Relaunch into it");
  expect(replay([started, ev("B2", "selfbuild.finished", { build_id: "b1", ok: true }), ev("B3", "ui.build_dismissed", {})]).selfbuild).toBeNull();
  expect(replay([started, ev("B2", "selfbuild.finished", { build_id: "b1", ok: true }), ev("B3", "app.started", {})]).selfbuild).toBeNull();
  expect(replay([started, ev("B2", "selfbuild.finished", { build_id: "b1", ok: false, step: "ui" })]).selfbuild).toBeNull();
});
