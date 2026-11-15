import { expect, test } from "vitest";
import { pickWorkspace, workspaceChips } from "./workspaces";
import type { SessionState } from "../state/types";

const ws = [{ id: "personal", name: "Personal", configDir: null, folder: null }, { id: "w1", name: "Client A", configDir: null, folder: null }];
const s = (workspace: string) => ({ workspace }) as SessionState;

test("the switcher counts sessions and needs-you per workspace, with All first", () => {
  const chips = workspaceChips(ws, [{ s: s("personal"), needs: true }, { s: s("w1"), needs: false }, { s: s("w1"), needs: true }, { s: s("gone"), needs: true }]);
  expect(chips.map((c) => [c.id, c.sessions, c.needs])).toEqual([["all", 4, 3], ["personal", 1, 1], ["w1", 2, 1]]);
});

test("a deleted workspace falls back to All", () => {
  expect(pickWorkspace("w1", ws)).toBe("w1");
  expect(pickWorkspace("deleted", ws)).toBe("all");
  expect(pickWorkspace(null, ws)).toBe("all");
});
