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
import type { BoardState, Task } from "./types";

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

export type AgentViewKind = "none" | "queued" | "working" | "waiting" | "blocked" | "done" | "failed" | "detached";
export interface AgentView { kind: AgentViewKind; label: string; title: string }

/** What to show for a task's agent: the file's `agent:` state refined by the live pane status. */
export function agentView(task: Task, pane: PaneStatus | undefined, alive: boolean): AgentView {
  const a = task.agent;
  if (alive && pane?.state === "blocked") return { kind: "blocked", label: "Needs you", title: `Claude is waiting for you${pane.kind ? ` (${pane.kind})` : ""}${pane.msg ? ` — ${pane.msg}` : ""}` };
  if (a === "blocked") return { kind: "blocked", label: "Blocked", title: "The agent is blocked and asked a question (see the progress log)" };
  if (a === "failed" || (alive && pane?.state === "error" && a === "running")) return { kind: "failed", label: "Failed", title: "The agent failed — see the progress log" };
  if (a === "queued") return { kind: "queued", label: "Queued", title: "Waiting for a free agent slot" };
  if (a === "done") return { kind: "done", label: "Agent done", title: "Claude finished this task" };
  if (a === "running") {
    if (!task.paneId) return { kind: "working", label: "Working", title: "A Claude session outside tCon is working on this" };
    if (!alive) return { kind: "detached", label: "Session ended", title: "The agent's terminal is gone" };
    if (pane?.state === "idle" || pane?.state === "done") return { kind: "waiting", label: "Waiting", title: "Claude finished its turn — open the terminal to continue" };
    return { kind: "working", label: "Working", title: pane?.title || "Claude is working on this task" };
  }
  return { kind: "none", label: "", title: "" };
}

export function buildPrompt(task: Task, root: string): string {
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

/** Agents occupying a slot on this board (running/blocked with a live pane). */
function busyCount(state: BoardState): number {
  return state.tasks.filter((t) => (t.agent === "running" || t.agent === "blocked") && livePane(t)).length;
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

async function launchInner(root: string, task: Task): Promise<boolean> {
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
  const cmd = `cd ${shq(project.rootPath)} && claude${modelFlag} ${shq(buildPrompt(task, project.rootPath))}`;
  const paneId = ws.addTerminal(project.id, {
    claude: true,
    command: cmd,
    title: `${task.id} · ${oneLine(task.title)}`.slice(0, 60),
    // Not restored after a restart: re-running the initial prompt would start the task over.
    ephemeral: true,
  });
  if (!paneId) return false;
  const status = task.status === "inbox" || task.status === "todo" ? "in-progress" : undefined;
  await useTasks.getState().update(root, task.id, { agent: "running", paneId, status, log: "Claude agent started in tCon" });
  return true;
}

/** "Let Claude work on this": start now, or queue when the board's agent limit is reached. */
export async function startAgent(root: string, id: string): Promise<void> {
  root = trim(root);
  const store = useTasks.getState();
  await store.load(root);
  const state = useTasks.getState().boards[root]?.state;
  const task = state?.tasks.find((t) => t.id === id);
  if (!state || !task) return;
  if (livePane(task) && (task.agent === "running" || task.agent === "blocked")) {
    openAgentTerminal(root, id);
    return;
  }
  if (busyCount(state) >= Math.max(1, state.board.settings.maxAgents || 1)) {
    await store.update(root, id, { agent: "queued", log: "Queued for a Claude agent" });
    return;
  }
  await launch(root, task);
}

export async function stopAgent(root: string, id: string): Promise<void> {
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
  void pumpQueue(root);
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

/** Start queued tasks while there are free agent slots. */
const pumping = new Set<string>();
export async function pumpQueue(root: string): Promise<void> {
  root = trim(root);
  if (pumping.has(root)) return;
  pumping.add(root);
  try {
    for (;;) {
      const state = useTasks.getState().boards[root]?.state;
      if (!state || !projectForRoot(root)) return;
      if (busyCount(state) >= Math.max(1, state.board.settings.maxAgents || 1)) return;
      const next = state.tasks.filter((t) => t.agent === "queued").sort((a, b) => a.updated.localeCompare(b.updated))[0];
      if (!next || !(await launch(root, next))) return;
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
    if (!t || busyKeys.has(key) || !t.paneId || !(t.agent === "running" || t.agent === "blocked") || livePane(t)) continue;
    busyKeys.add(key);
    changed = true;
    try {
      await useTasks.getState().update(root, t.id, { agent: "idle", paneId: "", log: "Agent terminal closed — session ended" });
    } finally {
      busyKeys.delete(key);
    }
  }
  if (changed) void pumpQueue(root);
}

/** Install the tcon-tasks skill into ~/.claude and every configured account's config dir. */
export async function installSkill(): Promise<string[]> {
  const home = await api.homeDir();
  const dirs = [`${home}/.claude`, ...useAccounts.getState().accounts.map((a) => a.configDir).filter((d): d is string => !!d)];
  return tasksApi.installSkill(dirs);
}

// ---------------- runtime ----------------

let runtimeInstalled = false;
/** Auto-pickup prompts, queue pumping and pane-death reaping. Call once (TasksHost). */
export function installAgentRuntime(): () => void {
  if (runtimeInstalled) return () => {};
  runtimeInstalled = true;

  const offLoad = onBoardLoaded((root, prev, next) => {
    // Ask to start Claude when a task (newly) enters Todo. Never on the first load of a board.
    if (prev && next.board.settings.askOnTodo && projectForRoot(root)) {
      const before = new Map(prev.tasks.map((t) => [t.id, t.status]));
      for (const t of next.tasks) {
        if (t.status === "todo" && before.get(t.id) !== "todo" && (t.agent === "idle" || !t.agent)) {
          useTasks.getState().pushPrompt({ root, taskId: t.id, title: t.title });
        }
      }
    }
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
