// Claude agents that work tasks: each runs in its own terminal pane (`claude '<prompt>'`) in the
// task's project, with the active account's env. The task file is the shared state: Claude
// updates status/agent/log per the tCon task protocol (.tcon/PROTOCOL.md = the tcon-tasks skill),
// and the app mirrors the pane's live OSC status (working / needs you / done) onto the card.
import { projectModel } from "../claudeModel";
import { api } from "../api";
import { findPane, useWorkspace } from "../store/workspace";
import { useAccounts } from "../store/accounts";
import { terminals } from "../terminal/registry";
import type { PaneStatus, Project } from "../types";
import { hasBackend, tasksApi } from "./api";
import { onBoardLoaded, taskById, useTasks } from "./store";
import type { AgentMode, BoardState, Task } from "./types";
import { insertIntoQueue, planMeta, previewGroups, schedule, type SchedInput, type SchedTask } from "./scheduler";
import { notifyTask } from "../notify";

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function projectForRoot(root: string): Project | undefined {
  const r = trim(root);
  return Object.values(useWorkspace.getState().projects).find((p) => trim(p.rootPath) === r);
}

/** The task's agent pane, if it is still open and running. */
export function livePane(task: Task): string | null {
  if (!task.paneId) return null;
  const found = findPane(useWorkspace.getState(), task.paneId);
  return found && !found[1].exited ? task.paneId : null;
}

export type AgentViewKind = "none" | "queued" | "planning" | "working" | "waiting" | "blocked" | "done" | "failed" | "detached";
export interface AgentView { kind: AgentViewKind; label: string; title: string }

/** What to show for a task's agent: the file's `agent:` state refined by the live pane status. */
export function agentView(task: Task, pane: PaneStatus | undefined, alive: boolean): AgentView {
  const a = task.agent;
  if (alive && pane?.state === "blocked") return { kind: "blocked", label: "Needs you", title: `Claude is waiting for you${pane.kind ? ` (${pane.kind})` : ""}${pane.msg ? ` — ${pane.msg}` : ""}` };
  if (a === "blocked") return { kind: "blocked", label: "Blocked", title: "The agent is blocked and asked a question (see the progress log)" };
  if (a === "failed" || (alive && pane?.state === "error" && a === "running")) return { kind: "failed", label: "Failed", title: "The agent failed — see the progress log" };
  if (a === "queued") return { kind: "queued", label: "Queued", title: "Waiting for a free agent slot" };
  if (a === "planning") {
    if (task.paneId && !alive) return { kind: "detached", label: "Planner ended", title: "The planning agent's terminal is gone" };
    return { kind: "planning", label: "Planning", title: "Claude is planning this task (no code changes)" };
  }
  if (a === "done") return { kind: "done", label: "Agent done", title: "Claude finished this task" };
  if (a === "running") {
    if (!task.paneId) return { kind: "working", label: "Working", title: "A Claude session outside tCon is working on this" };
    if (!alive) return { kind: "detached", label: "Session ended", title: "The agent's terminal is gone" };
    if (pane?.state === "idle" || pane?.state === "done") return { kind: "waiting", label: "Waiting", title: "Claude finished its turn — open the terminal to continue" };
    return { kind: "working", label: "Working", title: pane?.title || "Claude is working on this task" };
  }
  return { kind: "none", label: "", title: "" };
}

export function buildPrompt(task: Task, root: string, mode: AgentMode = "work"): string {
  if (mode === "plan") return buildPlanPrompt([task], root);
  const id = task.id;
  return oneLine(`
    Work on tCon task ${id} ("${oneLine(task.title)}"). The task file is .tcon/tasks/${id}.md in ${root}.
    Follow the tCon task protocol in .tcon/PROTOCOL.md (the same protocol as the tcon-tasks skill):
    claim the task, read it and inspect the relevant code, write a plan under ## Plan, implement it,
    verify with the project's tests/typecheck/build and record the results under ## Verification,
    then commit with a message starting with "${id}:".
    Keep the task file's frontmatter (status, agent, updated, branch, commits) and its ## Progress log
    updated at every stage, and finish with status: review and agent: done.
    If you need a decision from me, set agent: blocked, log the question, and ask me here.
  `);
}

/** Triage prompt for one or more tasks: plan only, no code changes, no commits. */
export function buildPlanPrompt(tasks: Task[], root: string): string {
  const list = tasks.map((t) => `${t.id} ("${oneLine(t.title)}")`).join(", ");
  const files = tasks.map((t) => `.tcon/tasks/${t.id}.md`).join(", ");
  return oneLine(`
    Triage and plan these tCon tasks in ${root}: ${list}. Task files: ${files}.
    Follow the "Triage (plan only)" section of the tCon task protocol in .tcon/PROTOCOL.md.
    Do not change any code and do not commit. For each task: read it and inspect the relevant code,
    write a concrete ## Plan (numbered steps, files to touch, how to verify) ending with a
    "Files: …" line, a "Parallel-safe: yes|no — reason" line and, if it needs other tasks first,
    a "Depends: T-x" line (and depends: [T-x] in the frontmatter). Set priority and labels if empty,
    then set status: todo and agent: idle and log "Triaged — plan written".
    If a task is too unclear to plan, leave it in inbox with agent: idle and log the question.
    Finish with a short summary of the plans and any dependencies between the tasks.
  `);
}

/** Agents occupying a slot on this board (running/blocked with a live pane). Planners don't
 *  take a slot: they only edit task files. */
function runningIds(state: BoardState): string[] {
  return state.tasks.filter((t) => (t.agent === "running" || t.agent === "blocked") && livePane(t)).map((t) => t.id);
}
function busyCount(state: BoardState): number {
  return runningIds(state).length;
}

/** The run queue in start order: the board's `runQueue` (queued tasks only), then queued
 *  tasks it doesn't list yet (oldest first). */
export function queueOrder(state: BoardState): string[] {
  const queued = new Map(state.tasks.filter((t) => t.agent === "queued").map((t) => [t.id, t]));
  const out = (state.board.runQueue ?? []).filter((id) => queued.has(id));
  const rest = [...queued.values()].filter((t) => !out.includes(t.id)).sort((a, b) => a.updated.localeCompare(b.updated));
  return [...out, ...rest.map((t) => t.id)];
}

function schedTasks(state: BoardState): Map<string, SchedTask> {
  return new Map(state.tasks.map((t) => [t.id, { id: t.id, status: t.status, agent: t.agent, priority: t.priority, meta: planMeta(t) }]));
}

export function schedInput(state: BoardState, oneShotRun = false): SchedInput {
  const s = state.board.settings;
  return {
    queue: queueOrder(state),
    tasks: schedTasks(state),
    running: runningIds(state),
    maxAgents: s.maxAgents || 1,
    runMode: s.runMode ?? "rolling",
    batchSize: s.batchSize || 2,
    batch: state.board.batch ?? [],
    paused: !!s.paused,
    oneShot: oneShotRun,
  };
}

/** What the queue panel shows: why each queued task waits, and the start groups. */
export function queuePreview(state: BoardState) {
  const input = schedInput(state);
  return { order: input.queue, waiting: schedule(input).waiting, groups: previewGroups(input) };
}

/** root::id of agents being launched or reaped right now (their task file is in flux). */
const busyKeys = new Set<string>();
const keyOf = (root: string, id: string) => `${trim(root)}::${id}`;

async function launch(root: string, task: Task): Promise<boolean> {
  const key = keyOf(root, task.id);
  if (busyKeys.has(key)) return false;
  busyKeys.add(key);
  try {
    return await launchInner(root, task);
  } finally {
    busyKeys.delete(key);
  }
}

async function launchInner(root: string, task: Task, mode: AgentMode = "work"): Promise<boolean> {
  const project = projectForRoot(root);
  if (!project) {
    useTasks.getState().setNotice(`Open ${root} as a project to run an agent.`, true);
    return false;
  }
  // Make sure .tcon/PROTOCOL.md exists (the prompt points at it).
  if (hasBackend()) await tasksApi.init(root).catch(() => {});
  const ws = useWorkspace.getState();
  const model = projectModel(project);
  const modelFlag = model === "default" ? "" : ` --model ${shq(model)}`;
  const cmd = `cd ${shq(project.rootPath)} && claude${modelFlag} ${shq(buildPrompt(task, project.rootPath, mode))}`;
  const paneId = ws.addTerminal(project.id, {
    claude: true,
    command: cmd,
    title: `${task.id} · ${oneLine(task.title)}`.slice(0, 60),
    // Not restored after a restart: re-running the initial prompt would start the task over.
    ephemeral: true,
  });
  if (!paneId) return false;
  if (mode === "plan") {
    await useTasks.getState().update(root, task.id, { agent: "planning", paneId, log: "Claude planner started in tCon" });
    return true;
  }
  const status = task.status === "inbox" || task.status === "todo" ? "in-progress" : undefined;
  await useTasks.getState().update(root, task.id, { agent: "running", paneId, status, log: "Claude agent started in tCon" });
  return true;
}

/** Split `items` into at most `n` chunks of near-equal size, keeping order. */
export function chunk<T>(items: T[], n: number): T[][] {
  const k = Math.max(1, Math.min(n, items.length));
  const size = Math.ceil(items.length / k);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "Plan with Claude": triage agents that write a plan for each task and move it to Todo,
 *  without touching code. Tasks are split over up to `maxAgents` planner sessions; planning
 *  doesn't wait for a free slot (planners only edit the task files). */
export async function planTasks(root: string, ids: string[]): Promise<number> {
  root = trim(root);
  const store = useTasks.getState();
  await store.load(root);
  const state = useTasks.getState().boards[root]?.state;
  const project = projectForRoot(root);
  if (!state) return 0;
  if (!project) {
    store.setNotice(`Open ${root} as a project to run an agent.`, true);
    return 0;
  }
  const tasks = ids
    .map((id) => state.tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t && t.status !== "done" && !(livePane(t) && ["running", "blocked", "planning"].includes(t.agent)));
  if (!tasks.length) return 0;
  if (hasBackend()) await tasksApi.init(root).catch(() => {});
  const model = projectModel(project);
  const modelFlag = model === "default" ? "" : ` --model ${shq(model)}`;
  let started = 0;
  for (const group of chunk(tasks, Math.max(1, state.board.settings.maxAgents || 1))) {
    const keys = group.map((t) => keyOf(root, t.id));
    if (keys.some((k) => busyKeys.has(k))) continue;
    keys.forEach((k) => busyKeys.add(k));
    try {
      const cmd = `cd ${shq(project.rootPath)} && claude${modelFlag} ${shq(buildPlanPrompt(group, project.rootPath))}`;
      const title = group.length === 1 ? `Plan ${group[0].id} · ${oneLine(group[0].title)}` : `Plan ${group.map((t) => t.id).join(", ")}`;
      const paneId = useWorkspace.getState().addTerminal(project.id, { claude: true, command: cmd, title: title.slice(0, 60), ephemeral: true });
      if (!paneId) continue;
      for (const t of group) await useTasks.getState().update(root, t.id, { agent: "planning", paneId, log: "Claude planner started in tCon" });
      started += group.length;
    } finally {
      keys.forEach((k) => busyKeys.delete(k));
    }
  }
  return started;
}

/** "Let Claude work on this": start now, or queue when the board's agent limit is reached. */
export async function startAgent(root: string, id: string): Promise<void> {
  root = trim(root);
  const store = useTasks.getState();
  await store.load(root);
  const state = useTasks.getState().boards[root]?.state;
  const task = state?.tasks.find((t) => t.id === id);
  if (!state || !task) return;
  if (livePane(task) && (task.agent === "running" || task.agent === "blocked" || task.agent === "planning")) {
    openAgentTerminal(root, id);
    return;
  }
  if (busyCount(state) >= Math.max(1, state.board.settings.maxAgents || 1)) {
    await enqueue(root, [id]);
    return;
  }
  await launch(root, task);
}

/** Add tasks to the run queue (at the board's pickup position, or `position`) and pump it. */
export async function enqueue(root: string, ids: string[], position?: string): Promise<void> {
  root = trim(root);
  const store = useTasks.getState();
  const state = store.boards[root]?.state;
  if (!state) return;
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const fresh = ids.filter((id) => {
    const t = byId.get(id);
    return t && t.status !== "done" && !(livePane(t) && ["running", "blocked", "planning"].includes(t.agent));
  });
  if (!fresh.length) return;
  for (const id of fresh) {
    if (byId.get(id)?.agent !== "queued") await store.update(root, id, { agent: "queued", log: "Queued for a Claude agent" });
  }
  const cur = useTasks.getState().boards[root]?.state ?? state;
  const order = insertIntoQueue(queueOrder(cur).filter((id) => !fresh.includes(id)), fresh, position ?? cur.board.settings.pickupPosition ?? "end", (id) => byId.get(id)?.priority ?? "none");
  await store.setQueue(root, order);
  void pumpQueue(root);
}

/** Drag-and-drop reorder of the run queue. */
export async function reorderQueue(root: string, order: string[]): Promise<void> {
  await useTasks.getState().setQueue(trim(root), order);
  void pumpQueue(root);
}

// ---------------- stop / resume (queue pause) ----------------

/** Roots where "Stop after current" waits for running agents (notify when they're done). */
const stopping = new Set<string>();
/** Roots where "Start next only" may start exactly one agent despite the pause. */
const oneShot = new Set<string>();

export async function stopAfterCurrent(root: string): Promise<void> {
  root = trim(root);
  await useTasks.getState().saveSettings(root, { paused: true });
  const state = useTasks.getState().boards[root]?.state;
  if (state && busyCount(state) > 0) stopping.add(root);
  else useTasks.getState().setNotice(`Queue stopped${state ? ` — ${queueOrder(state).length} waiting` : ""}.`);
}

export async function resumeQueue(root: string): Promise<void> {
  root = trim(root);
  stopping.delete(root);
  oneShot.delete(root);
  await useTasks.getState().saveSettings(root, { paused: false });
  void pumpQueue(root);
}

/** Start exactly one queued task, then stay stopped. */
export async function startNextOnly(root: string): Promise<void> {
  root = trim(root);
  oneShot.add(root);
  if (!useTasks.getState().boards[root]?.state?.board.settings.paused) await useTasks.getState().saveSettings(root, { paused: true });
  void pumpQueue(root);
}

/** Stop the queue and every running agent of the board now. */
export async function stopAllNow(root: string): Promise<void> {
  root = trim(root);
  await useTasks.getState().saveSettings(root, { paused: true });
  stopping.delete(root);
  const state = useTasks.getState().boards[root]?.state;
  for (const id of state ? runningIds(state) : []) await stopAgent(root, id, { pump: false });
  for (const t of state?.tasks ?? []) {
    if (t.agent === "planning" && livePane(t)) await stopAgent(root, t.id, { pump: false });
  }
}

/** Roots of loaded boards (for the global stop / resume). */
export const boardRoots = () => Object.keys(useTasks.getState().boards).filter((r) => useTasks.getState().boards[r]?.state && projectForRoot(r));

/** Notify once a stopped queue has drained, or when all queued work is finished. */
const hadWork = new Set<string>();
function checkDrained(root: string, state: BoardState) {
  const busy = busyCount(state);
  const waiting = queueOrder(state).length;
  const name = projectForRoot(root)?.name ?? root;
  if (stopping.has(root) && busy === 0) {
    stopping.delete(root);
    const text = `Queue stopped — ${waiting} waiting`;
    useTasks.getState().setNotice(`${name}: ${text}. Resume it from the board header.`);
    void notifyTask(`${name} · ${text}`, "The running agents have finished.");
  }
  if (busy > 0 || waiting > 0) hadWork.add(root);
  else if (hadWork.delete(root) && !state.board.settings.paused) {
    void notifyTask(`${name} · run queue finished`, "Every queued task has been worked on.");
  }
}

export async function stopAgent(root: string, id: string, opts: { pump?: boolean } = {}): Promise<void> {
  root = trim(root);
  const task = taskById(root, id);
  if (!task) return;
  const pane = livePane(task);
  if (pane) {
    const ws = useWorkspace.getState();
    const found = findPane(ws, pane);
    if (found) {
      const [project] = found;
      // Closing the last terminal of a project closes the project, so only interrupt then.
      const others = Object.keys(project.panes).length > 1 || project.editorGroups.some((g) => g.tabs.length);
      if (others) ws.closePane(project.id, pane);
      else void api.ptyWrite(pane, "\x1b\x03").catch(() => {});
    }
  }
  await useTasks.getState().update(root, id, { agent: "idle", paneId: "", log: task.agent === "queued" ? "Removed from the agent queue" : "Agent stopped by user" });
  const st = useTasks.getState().boards[root]?.state;
  if (st?.board.runQueue?.includes(id)) await useTasks.getState().setQueue(root, st.board.runQueue.filter((x) => x !== id));
  if (opts.pump !== false) void pumpQueue(root);
}

export function openAgentTerminal(root: string, id: string): boolean {
  const task = taskById(root, id);
  const pane = task && livePane(task);
  const found = pane ? findPane(useWorkspace.getState(), pane) : null;
  if (!found || !pane) return false;
  const ws = useWorkspace.getState();
  ws.setActive(found[0].id);
  ws.focusPane(found[0].id, pane);
  requestAnimationFrame(() => terminals.focus(pane));
  return true;
}

/** Start whatever the scheduler says may start now (run mode, free slots, dependencies,
 *  file conflicts, pause). */
const pumping = new Set<string>();
export async function pumpQueue(root: string): Promise<void> {
  root = trim(root);
  if (pumping.has(root)) return;
  pumping.add(root);
  try {
    for (let guard = 0; guard < 32; guard++) {
      const state = useTasks.getState().boards[root]?.state;
      if (!state || !projectForRoot(root)) return;
      const input = schedInput(state, oneShot.has(root));
      const r = schedule(input);
      if (!r.start.length) {
        checkDrained(root, state);
        return;
      }
      if (oneShot.delete(root)) useTasks.getState().setNotice("Started the next task; the queue stays stopped.");
      const rest = input.queue.filter((id) => !r.start.includes(id));
      await useTasks.getState().setQueue(root, rest, r.batch);
      let launched = 0;
      for (const id of r.start) {
        const t = state.tasks.find((x) => x.id === id);
        if (t && (await launch(root, t))) launched++;
      }
      if (!launched) return;
    }
  } finally {
    pumping.delete(root);
  }
}

/** Mark agents whose tCon pane is gone (closed, exited, app restarted) as no longer running. */
async function reapDeadAgents(root: string) {
  if (!useWorkspace.getState().loaded) return;
  const state = useTasks.getState().boards[root]?.state;
  if (!state || !projectForRoot(root)) return;
  let changed = false;
  for (const stale of state.tasks) {
    const key = keyOf(root, stale.id);
    const t = taskById(root, stale.id);
    if (!t || busyKeys.has(key) || !t.paneId || !(t.agent === "running" || t.agent === "blocked" || t.agent === "planning") || livePane(t)) continue;
    busyKeys.add(key);
    changed = true;
    try {
      const msg = t.agent === "planning" ? "Planner terminal closed before the plan was finished" : "Agent terminal closed — session ended";
      await useTasks.getState().update(root, t.id, { agent: "idle", paneId: "", log: msg });
    } finally {
      busyKeys.delete(key);
    }
  }
  if (changed) void pumpQueue(root);
}

async function skillDirs(): Promise<string[]> {
  const home = await api.homeDir();
  return [`${home}/.claude`, ...useAccounts.getState().accounts.map((a) => a.configDir).filter((d): d is string => !!d)];
}

/** Install the tcon-tasks skill into ~/.claude and every configured account's config dir. */
export async function installSkill(): Promise<string[]> {
  return tasksApi.installSkill(await skillDirs());
}

/** Bring installed copies of the skill up to date with this tCon version. */
async function refreshInstalledSkill() {
  if (!hasBackend()) return;
  try {
    const updated = await tasksApi.refreshSkill(await skillDirs());
    if (updated.length) useTasks.getState().setNotice(`Updated the tcon-tasks skill to this tCon version (${updated.length} location${updated.length === 1 ? "" : "s"}).`);
  } catch {
    /* best effort */
  }
}

// ---------------- runtime ----------------

/** Desktop notifications when an agent gets blocked, fails or finishes (written by Claude). */
function notifyTransitions(root: string, prev: BoardState, next: BoardState) {
  const before = new Map(prev.tasks.map((t) => [t.id, t.agent]));
  const name = projectForRoot(root)?.name ?? root;
  for (const t of next.tasks) {
    const was = before.get(t.id);
    if (was === undefined || was === t.agent) continue;
    if (t.agent === "blocked") void notifyTask(`${name} · ${t.id} needs you`, t.title);
    else if (t.agent === "failed") void notifyTask(`${name} · ${t.id} failed`, t.title);
    else if (t.agent === "done" && (was === "running" || was === "blocked")) void notifyTask(`${name} · ${t.id} is ready for review`, t.title);
  }
}

/** Collect new Inbox cards for a moment so a burst of captures shares one planner. */
const planBuffer = new Map<string, { ids: Set<string>; timer: number }>();
function schedulePlan(root: string, ids: string[]) {
  const cur = planBuffer.get(root) ?? { ids: new Set<string>(), timer: 0 };
  ids.forEach((id) => cur.ids.add(id));
  window.clearTimeout(cur.timer);
  cur.timer = window.setTimeout(() => {
    planBuffer.delete(root);
    void planTasks(root, [...cur.ids]);
  }, 2500);
  planBuffer.set(root, cur);
}

let runtimeInstalled = false;
/** Auto-pickup prompts, queue pumping and pane-death reaping. Call once (TasksHost). */
export function installAgentRuntime(): () => void {
  if (runtimeInstalled) return () => {};
  runtimeInstalled = true;
  window.setTimeout(() => void refreshInstalledSkill(), 3000);

  const offLoad = onBoardLoaded((root, prev, next) => {
    // Never on the first load of a board.
    if (prev && projectForRoot(root)) {
      const before = new Map(prev.tasks.map((t) => [t.id, t.status]));
      const idle = (t: Task) => t.agent === "idle" || !t.agent;
      const s = next.board.settings;
      // A task (newly) entered Todo: ask, or queue it right away.
      const entered = next.tasks.filter((t) => t.status === "todo" && before.get(t.id) !== "todo" && idle(t));
      if (entered.length && s.autoPickup === "ask") {
        for (const t of entered) useTasks.getState().pushPrompt({ root, taskId: t.id, title: t.title });
      } else if (entered.length && s.autoPickup === "auto") {
        void enqueue(root, entered.map((t) => t.id));
      }
      // New Inbox cards get a planner.
      if (s.inboxAutoPlan && !s.paused) {
        const fresh = next.tasks.filter((t) => !before.has(t.id) && t.status === "inbox" && idle(t));
        if (fresh.length) schedulePlan(root, fresh.map((t) => t.id));
      }
    }
    if (prev) notifyTransitions(root, prev, next);
    // A task that left Todo / got an agent no longer needs its prompt.
    for (const p of useTasks.getState().prompts) {
      if (p.root !== root) continue;
      const t = next.tasks.find((x) => x.id === p.taskId);
      if (!t || t.status !== "todo" || (t.agent !== "idle" && t.agent !== "")) useTasks.getState().dismissPrompt(p.key);
    }
    void reapDeadAgents(root).then(() => pumpQueue(root));
  });

  // Panes closing / exiting frees agent slots.
  let timer: number | undefined;
  const offWs = useWorkspace.subscribe((s, prev) => {
    if (s.projects === prev.projects && s.loaded === prev.loaded) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      for (const root of Object.keys(useTasks.getState().boards)) void reapDeadAgents(root);
    }, 800);
  });

  return () => {
    runtimeInstalled = false;
    offLoad();
    offWs();
    window.clearTimeout(timer);
  };
}
