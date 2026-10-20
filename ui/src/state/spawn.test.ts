import { describe, expect, test } from "vitest";
import { groupSpawned } from "./spawn";
import type { SessionState } from "./types";

const s = (id: string, parent?: string) => ({ id, title: id, spawnedBy: parent ? { id: parent, title: parent } : null }) as unknown as SessionState;

describe("spawn groups on the Wall (MR-179)", () => {
  const sessions = Object.fromEntries([s("a"), s("p"), s("c1", "p"), s("b"), s("c2", "p"), s("d"), s("e", "d"), s("o", "gone")].map((x) => [x.id, x]));

  test("a parent and its children form one block where the first of them stood", () => {
    const g = groupSpawned(["a", "p", "c1", "b", "c2", "e", "o"], ["d"], sessions);
    expect(g.families).toEqual([{ parent: "p", running: true, children: ["c1", "c2"] }, { parent: "gone", running: false, children: ["o"] }]);
    expect(g.loose).toEqual(["a", "b"]);
  });

  test("children of a session in a doc group join that group", () => {
    const g = groupSpawned(["e"], ["d"], sessions);
    expect(g.childrenOf.get("d")).toEqual(["e"]);
    expect(g.families).toEqual([]);
    expect(g.loose).toEqual([]);
  });

  test("a session nobody spawned and that spawned nothing stays loose", () => {
    expect(groupSpawned(["a", "b"], [], sessions)).toMatchObject({ families: [], loose: ["a", "b"] });
  });
});
