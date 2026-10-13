import { describe, expect, it } from "vitest";
import { releaseView, type ReleaseStatus } from "./ReleaseBanner";

const base: ReleaseStatus = { mode: "merge", phase: "idle", version: "0.2.0", notes: "", preview: null, failure: null, updated: null };
const choices = (s: ReleaseStatus) => releaseView(s)?.actions.map((a) => a.choice);

describe("release banner (MR-136)", () => {
  it("stays out of the way when there's nothing new", () => {
    expect(releaseView(base)).toBeNull();
  });

  it("a release build restarts into the release", () => {
    expect(choices({ ...base, mode: "swap", phase: "available" })).toEqual(["install"]);
    expect(releaseView({ ...base, mode: "swap", phase: "available" })?.actions[0].label).toBe("Restart to update");
  });

  it("a self-built app merges a clean release into its changes", () => {
    const v = releaseView({ ...base, phase: "ready", preview: { yours: 3, brings: 9, conflicts: [] } });
    expect(v?.detail).toBe("merges cleanly with your 3 changes");
    expect(v?.actions[0].label).toBe("Merge into my build");
  });

  it("a clash changes nothing and offers plan, keep, set aside", () => {
    const v = releaseView({ ...base, phase: "conflicts", preview: { yours: 1, brings: 4, conflicts: ["ui/src/a.tsx"] } });
    expect(v?.detail).toContain("1 file clash with your changes: ui/src/a.tsx");
    expect(v?.detail).toContain("nothing changed");
    expect(v?.actions.map((a) => a.choice)).toEqual(["plan", "keep", "take", "details"]);
  });

  it("a failed build or health check offers the same choices; a failed download offers retry", () => {
    expect(choices({ ...base, phase: "failed", failure: { stage: "build", log: "x" } })).toEqual(["plan", "keep", "take", "details"]);
    expect(releaseView({ ...base, phase: "failed", failure: { stage: "health", log: "" } })?.title).toContain("previous build is back");
    expect(choices({ ...base, mode: "swap", phase: "failed", failure: { stage: "download", log: "x" } })).toEqual(["retry", "keep", "details"]);
  });

  it("says once that it updated", () => {
    expect(releaseView({ ...base, updated: "0.2.0" })?.title).toBe("✓ Updated to Cockpit 0.2.0");
  });
});
