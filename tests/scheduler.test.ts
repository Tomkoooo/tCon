// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { insertIntoQueue, planMeta, previewGroups, schedule, type SchedInput, type SchedTask } from "../src/tasks/scheduler.ts";

const mk = (id: string, files: string[] | null, extra: Partial<SchedTask> = {}): SchedTask => ({
  id, status: "todo", agent: "queued", priority: "none",
  meta: { files, parallelSafe: files ? true : null, depends: [] }, ...extra,
});
const input = (tasks: SchedTask[], over: Partial<SchedInput> = {}): SchedInput => ({
  queue: tasks.map((t) => t.id), tasks: new Map(tasks.map((t) => [t.id, t])), running: [],
  maxAgents: 2, runMode: "rolling", batchSize: 2, batch: [], paused: false, ...over,
});

test("planMeta reads the triage lines", () => {
  const m = planMeta({ id: "T-5", depends: ["T-1"], sections: "## Plan\n1. x\n- **Files:** `src/a.ts`, src-tauri/src/b.rs\nParallel-safe: no — touches lib.rs\nDepends: T-2, T-5\n\n## Progress log\nFiles: nope" });
  assert.deepEqual(m.files, ["src/a.ts", "src-tauri/src/b.rs"]);
  assert.equal(m.parallelSafe, false);
  assert.deepEqual(m.depends.sort(), ["T-1", "T-2"]);
  assert.deepEqual(planMeta({ id: "T-1", sections: "## Plan\n" }), { files: null, parallelSafe: null, depends: [] });
});

test("rolling fills free slots in queue order", () => {
  const ts = [mk("T-1", null), mk("T-2", null), mk("T-3", null)];
  assert.deepEqual(schedule(input(ts)).start, ["T-1", "T-2"]);
  assert.deepEqual(schedule(input(ts, { running: ["T-9"] })).start, ["T-1"]);
  assert.deepEqual(schedule(input(ts, { paused: true })).start, []);
  assert.deepEqual(schedule(input(ts, { paused: true, oneShot: true })).start, ["T-1"]);
});

test("dependencies hold tasks back until review/done", () => {
  const dep = mk("T-1", null, { agent: "idle", status: "in-progress" });
  const t2 = mk("T-2", null, { meta: { files: null, parallelSafe: null, depends: ["T-1"] } });
  const r = schedule(input([dep, t2], { queue: ["T-2"] }));
  assert.deepEqual(r.start, []);
  assert.match(r.waiting.get("T-2")!, /T-1/);
  const r2 = schedule(input([{ ...dep, status: "review" }, t2], { queue: ["T-2"] }));
  assert.deepEqual(r2.start, ["T-2"]);
});

test("batch waits for the whole batch", () => {
  const ts = [mk("T-1", null), mk("T-2", null), mk("T-3", null)];
  const r = schedule(input(ts, { runMode: "batch", batchSize: 2 }));
  assert.deepEqual(r.start, ["T-1", "T-2"]);
  assert.deepEqual(r.batch, ["T-1", "T-2"]);
  assert.deepEqual(schedule(input(ts, { runMode: "batch", batch: ["T-0", "T-4"], running: ["T-4"] })).start, []);
});

test("parallel-safe groups by files and isolates exclusive tasks", () => {
  const a = mk("T-1", ["a.ts"]);
  const b = mk("T-2", ["a.ts", "b.ts"]);
  const c = mk("T-3", ["c.ts"]);
  const r = schedule(input([a, b, c], { runMode: "parallel-safe", maxAgents: 3 }));
  assert.deepEqual(r.start, ["T-1", "T-3"]);
  assert.match(r.waiting.get("T-2")!, /same files/);
  // An exclusive task at the head runs alone once nothing runs.
  const x = mk("T-4", null);
  assert.deepEqual(schedule(input([x, c], { runMode: "parallel-safe", maxAgents: 3 })).start, ["T-4"]);
  assert.deepEqual(schedule(input([x, c], { runMode: "parallel-safe", maxAgents: 3, running: ["T-1"], tasks: new Map([[x.id, x], [c.id, c], [a.id, { ...a, agent: "running" }]]) })).start, []);
  assert.deepEqual(previewGroups(input([a, b, c], { runMode: "parallel-safe", maxAgents: 3 })), [["T-1", "T-3"], ["T-2"]]);
});

test("queue insertion by position", () => {
  const prio: Record<string, string> = { A: "high", B: "low", C: "medium", N: "medium" };
  const p = (id: string) => prio[id] ?? "none";
  assert.deepEqual(insertIntoQueue(["A", "B"], ["N"], "end", p), ["A", "B", "N"]);
  assert.deepEqual(insertIntoQueue(["A", "B"], ["N"], "front", p), ["N", "A", "B"]);
  assert.deepEqual(insertIntoQueue(["A", "C", "B"], ["N"], "priority", p), ["A", "C", "N", "B"]);
});
