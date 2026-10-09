import { expect, test } from "bun:test";

// Runs the sidecar as a real child process and talks to it over stdio, like the Rust core does.
test("announces itself and answers ping over NDJSON", async () => {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/main.ts`], { stdin: "pipe", stdout: "pipe" });
  proc.stdin.write(JSON.stringify({ type: "ping", id: "t1" }) + "\n");
  proc.stdin.end();
  const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0].type).toBe("ready");
  expect(lines[1]).toMatchObject({ type: "pong", id: "t1" });
});

test("rejects malformed lines without dying", async () => {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/main.ts`], { stdin: "pipe", stdout: "pipe" });
  proc.stdin.write("not json\n" + JSON.stringify({ type: "ping", id: "t2" }) + "\n");
  proc.stdin.end();
  const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual(["ready", "error", "pong"]);
});
