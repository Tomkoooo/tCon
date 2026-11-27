// Live agent status across every loaded board: which agent works on which task, in which
// phase of the protocol, and for how long. Used by the status bar popover, the board strip
// and the card phase chips.
import { useWorkspace } from "../store/workspace";
import { agentView, livePane, projectForRoot, type AgentView } from "./agent";
import { useTasks } from "./store";
import type { Task } from "./types";

export type Phase = "triage" | "starting" | "planning" | "implementing" | "verifying" | "done";

export const PHASE_LABEL: Record<Phase, string> = {
  triage: "Triage",
  starting: "Starting",
  planning: "Planning",
  implementing: "Implementing",
  verifying: "Verifying",
  done: "Done",
};

const LOG_LINE = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) — (.*)$/;

interface LogEntry { at: number; msg: string }

export function logEntries(sections: string): LogEntry[] {
  const m = /(?:^|\n)## Progress log\s*\n([\s\S]*?)(?=\n## |$)/i.exec(sections);
  if (!m) return [];
  const out: LogEntry[] = [];
  for (const line of m[1].split("\n")) {
    const x = LOG_LINE.exec(line.trim());
    if (x) out.push({ at: new Date(+x[1], +x[2] - 1, +x[3], +x[4], +x[5]).getTime(), msg: x[6] });
  }
  return out;
}

function sectionHasText(sections: string, name: string): boolean {
  const m = new RegExp(`(?:^|\\n)## ${name}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "i").exec(sections);
  return !!m && m[1].trim().length > 0;
}

/** Phase of the current agent run, from the protocol's log lines since the last start. */
export function taskPhase(task: Task): { phase: Phase; since: number | null } {
  const log = logEntries(task.sections);
  let start = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (/\b(agent|planner) started\b|^started\b/i.test(log[i].msg)) {
      start = i;
      break;
    }
  }
  const run = start >= 0 ? log.slice(start) : log;
  const since = start >= 0 ? log[start].at : null;
  if (task.agent === "planning") return { phase: "triage", since };
  const has = (re: RegExp) => run.some((e) => re.test(e.msg));
  if (task.agent === "done" || has(/^done\b/i)) return { phase: "done", since };
  if (has(/verif|tests? (pass|fail)|typecheck/i)) return { phase: "verifying", since };
  if (has(/plan written|implement/i)) return { phase: sectionHasText(task.sections, "Verification") && has(/verif/i) ? "verifying" : "implementing", since };
  if (has(/^started\b|claimed/i)) return { phase: "planning", since };
  return { phase: "starting", since };
}

export interface AgentEntry {
  root: string;
  projectId: string | null;
  projectName: string;
  task: Task;
  view: AgentView;
  phase: Phase;
  since: number | null;
  /** pane title or the OSC message (what Claude says it's doing) */
  detail: string;
}

const ACTIVE = new Set(["working", "blocked", "waiting", "planning", "queued", "interrupted", "limited", "failed", "detached"]);

/** Every task with agent activity on every loaded board. Not a hook: call inside a selector. */
export function collectAgents(): AgentEntry[] {
  const ws = useWorkspace.getState();
  const out: AgentEntry[] = [];
  for (const [root, entry] of Object.entries(useTasks.getState().boards)) {
    const st = entry.state;
    if (!st) continue;
    const project = projectForRoot(root);
    for (const t of st.tasks) {
      if (t.agent === "idle" || t.agent === "done" || !t.agent) continue;
      const pane = t.paneId ? ws.statuses[t.paneId] : undefined;
      const view = agentView(t, pane, !!livePane(t));
      if (!ACTIVE.has(view.kind)) continue;
      const { phase, since } = taskPhase(t);
      const paneTitle = t.paneId ? project?.panes[t.paneId]?.title : undefined;
      out.push({
        root,
        projectId: project?.id ?? null,
        projectName: project?.name ?? root.split("/").pop() ?? root,
        task: t,
        view,
        phase,
        since,
        detail: pane?.msg || pane?.title || paneTitle || "",
      });
    }
  }
  const rank: Record<string, number> = { blocked: 0, limited: 1, failed: 2, interrupted: 3, working: 4, planning: 5, waiting: 6, detached: 7, queued: 8 };
  return out.sort((a, b) => (rank[a.view.kind] ?? 9) - (rank[b.view.kind] ?? 9) || a.task.id.localeCompare(b.task.id, undefined, { numeric: true }));
}

export function summarize(list: AgentEntry[]) {
  const c = { running: 0, needsYou: 0, queued: 0, planning: 0, failed: 0, paused: 0 };
  for (const e of list) {
    if (e.view.kind === "working" || e.view.kind === "waiting") c.running++;
    else if (e.view.kind === "blocked") c.needsYou++;
    else if (e.view.kind === "queued") c.queued++;
    else if (e.view.kind === "planning") c.planning++;
    else if (e.view.kind === "failed") c.failed++;
    else if (e.view.kind === "interrupted" || e.view.kind === "limited") c.paused++;
  }
  return c;
}

export function elapsed(since: number | null, now = Date.now()): string {
  if (!since) return "";
  const m = Math.max(0, Math.round((now - since) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
