// Run-queue scheduling, as pure functions (no stores, no I/O) so they can be unit tested.
// The agent runtime (agent.ts) feeds in the board's queue, tasks and settings and launches
// whatever `schedule()` says should start now.
import type { Task } from "./types";

export type RunMode = "rolling" | "batch" | "parallel-safe";

export interface PlanMeta {
  /** Files the plan expects to change; null = the plan doesn't say (treated as "conflicts with everything"). */
  files: string[] | null;
  /** `Parallel-safe:` line; null = not stated. */
  parallelSafe: boolean | null;
  /** Task ids from `Depends:` lines and the `depends:` frontmatter. */
  depends: string[];
}

const ID = /\bT-\d+\b/g;

/** Read the triage lines (`Files:`, `Parallel-safe:`, `Depends:`) from a task's `## Plan`. */
export function planMeta(task: Pick<Task, "sections" | "id"> & { depends?: string[] }): PlanMeta {
  const plan = /(?:^|\n)## Plan\s*\n([\s\S]*?)(?=\n## |$)/i.exec(task.sections ?? "")?.[1] ?? "";
  let files: string[] | null = null;
  let parallelSafe: boolean | null = null;
  const depends = new Set<string>(task.depends ?? []);
  for (const raw of plan.split("\n")) {
    const line = raw.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").trim();
    const m = /^(files|parallel[- ]safe|depends(?: on)?)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "files") {
      files = val
        .split(/[,\s]+/)
        .map((f) => f.replace(/[`'"]/g, "").replace(/^\.\//, "").trim())
        .filter((f) => f && f !== "-" && f.toLowerCase() !== "none");
    } else if (key.startsWith("parallel")) {
      parallelSafe = /^(yes|true|igen)\b/i.test(val) ? true : /^(no|false|nem)\b/i.test(val) ? false : null;
    } else {
      for (const id of val.match(ID) ?? []) if (id !== task.id) depends.add(id);
    }
  }
  return { files, parallelSafe, depends: [...depends] };
}

export interface SchedTask {
  id: string;
  status: string;
  agent: string;
  priority: string;
  meta: PlanMeta;
}

export interface SchedInput {
  queue: string[];
  tasks: Map<string, SchedTask>;
  /** Ids with a live agent occupying a slot. */
  running: string[];
  maxAgents: number;
  runMode: RunMode;
  batchSize: number;
  batch: string[];
  paused: boolean;
  /** "Start next only": start at most one even while paused. */
  oneShot?: boolean;
}

export interface SchedResult {
  start: string[];
  /** New value of the board's `batch` (batch mode), when it changes. */
  batch?: string[];
  /** Why queued tasks aren't starting (for the queue panel). */
  waiting: Map<string, string>;
}

const DONEISH = new Set(["review", "done"]);

export function depsReady(t: SchedTask, tasks: Map<string, SchedTask>): string[] {
  return t.meta.depends.filter((d) => {
    const dep = tasks.get(d);
    return dep !== undefined && !DONEISH.has(dep.status);
  });
}

/** A task that must run alone: no Files line, or Parallel-safe: no. */
const exclusive = (t: SchedTask) => t.meta.files === null || t.meta.parallelSafe === false;

function overlaps(a: string[], b: Set<string>): boolean {
  return a.some((f) => b.has(f));
}

export function schedule(input: SchedInput): SchedResult {
  const waiting = new Map<string, string>();
  const eligible: SchedTask[] = [];
  for (const id of input.queue) {
    const t = input.tasks.get(id);
    if (!t || t.agent !== "queued" || t.status === "done") continue;
    const blockedBy = depsReady(t, input.tasks);
    if (blockedBy.length) {
      waiting.set(id, `Waits for ${blockedBy.join(", ")}`);
      continue;
    }
    eligible.push(t);
  }
  const reason = (msg: string, from = 0) => eligible.slice(from).forEach((t) => !waiting.has(t.id) && waiting.set(t.id, msg));

  if (input.paused && !input.oneShot) {
    reason("Queue stopped");
    return { start: [], waiting };
  }
  const cap = input.oneShot ? 1 : Infinity;
  const max = Math.max(1, input.maxAgents);

  if (input.runMode === "batch") {
    const active = input.batch.filter((id) => input.running.includes(id));
    if (active.length) {
      reason(`Waits for the current batch (${active.join(", ")})`);
      return { start: [], waiting };
    }
    if (input.running.length && !input.oneShot) {
      reason("Waits for running agents to finish");
      return { start: [], waiting };
    }
    const size = Math.min(Math.max(1, input.batchSize), cap);
    const start = eligible.slice(0, size).map((t) => t.id);
    reason("Next batch", size);
    return { start, batch: start, waiting };
  }

  const free = Math.min(max - input.running.length, cap);
  if (free <= 0) {
    reason("Waits for a free agent slot");
    return { start: [], waiting };
  }

  if (input.runMode === "rolling") {
    const start = eligible.slice(0, free).map((t) => t.id);
    reason("Waits for a free agent slot", start.length);
    return { start, waiting };
  }

  // parallel-safe: greedy, in queue order, skipping tasks whose files overlap.
  const busyFiles = new Set<string>();
  let anyExclusiveRunning = false;
  for (const id of input.running) {
    const t = input.tasks.get(id);
    if (!t || exclusive(t)) anyExclusiveRunning = true;
    else t.meta.files!.forEach((f) => busyFiles.add(f));
  }
  if (anyExclusiveRunning) {
    reason("Waits for an agent that must run alone");
    return { start: [], waiting };
  }
  const start: string[] = [];
  for (let i = 0; i < eligible.length && start.length < free; i++) {
    const t = eligible[i];
    if (exclusive(t)) {
      if (start.length === 0 && input.running.length === 0) {
        start.push(t.id);
        reason("Waits: the task before it runs alone", i + 1);
        return { start, waiting };
      }
      waiting.set(t.id, t.meta.files === null ? "Runs alone (no Files line in its plan)" : "Runs alone (not parallel-safe)");
      // Don't let later tasks overtake a task that needs the whole tree.
      reason("Waits for a task that runs alone", i + 1);
      return { start, waiting };
    }
    if (overlaps(t.meta.files!, busyFiles)) {
      waiting.set(t.id, "Touches the same files as a running task");
      continue;
    }
    start.push(t.id);
    t.meta.files!.forEach((f) => busyFiles.add(f));
  }
  reason("Waits for a free agent slot");
  return { start, waiting };
}

/** Preview of the start order as groups: what starts now, then next, … (assumes each group
 *  finishes before the next one starts). */
export function previewGroups(input: SchedInput, limit = 6): string[][] {
  const groups: string[][] = [];
  const tasks = new Map(input.tasks);
  let queue = [...input.queue];
  let running = [...input.running];
  let batch = [...input.batch];
  for (let g = 0; g < limit && queue.length; g++) {
    const r = schedule({ ...input, queue, tasks, running, batch, paused: false, oneShot: false });
    if (!r.start.length) {
      if (!running.length) break;
      running = [];
      batch = [];
      continue;
    }
    groups.push(r.start);
    for (const id of r.start) {
      const t = tasks.get(id);
      if (t) tasks.set(id, { ...t, agent: "running", status: "review" });
    }
    queue = queue.filter((id) => !r.start.includes(id));
    running = [];
    batch = [];
  }
  return groups;
}

const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
export const prioRank = (p: string) => PRIO_RANK[p] ?? 4;

/** Insert ids into a queue: at the end, the front, or by priority (after equal priority). */
export function insertIntoQueue(queue: string[], ids: string[], position: string, priorityOf: (id: string) => string): string[] {
  const rest = queue.filter((id) => !ids.includes(id));
  if (position === "front") return [...ids, ...rest];
  if (position !== "priority") return [...rest, ...ids];
  const out = [...rest];
  for (const id of ids) {
    const r = prioRank(priorityOf(id));
    const at = out.findIndex((x) => prioRank(priorityOf(x)) > r);
    out.splice(at < 0 ? out.length : at, 0, id);
  }
  return out;
}
