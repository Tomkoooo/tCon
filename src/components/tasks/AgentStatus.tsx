// Live agent status UI: the status bar item with its popover (every project), the board
// strip (one project) and the phase chip on cards. Data: src/tasks/status.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../store/workspace";
import { useTasks } from "../../tasks/store";
import { boardRoots, openAgentTerminal, resumeQueue, stopAfterCurrent, stopAgent } from "../../tasks/agent";
import { openBoard } from "../../tasks/actions";
import { PHASE_LABEL, collectAgents, elapsed, summarize, taskPhase, type AgentEntry } from "../../tasks/status";
import type { Task } from "../../tasks/types";
import { Icon } from "../icons";
import { AgentChip, ClaudeMark } from "./parts";

/** Re-render every 30 s so elapsed times move. */
function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

export function useAgents(root?: string): AgentEntry[] {
  const boards = useTasks((s) => s.boards);
  const statuses = useWorkspace((s) => s.statuses);
  const projects = useWorkspace((s) => s.projects);
  useTick();
  return useMemo(() => {
    const all = collectAgents();
    const r = root?.replace(/\/+$/, "");
    return r ? all.filter((e) => e.root === r) : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, statuses, projects, root]);
}

/** Phase chip for an active card ("Implementing · 12m"). */
export function PhaseChip({ task }: { task: Task }) {
  if (!["running", "blocked", "planning"].includes(task.agent)) return null;
  const { phase, since } = taskPhase(task);
  const t = elapsed(since);
  return (
    <span className={`tk-phase tk-phase-${phase}`} title={`Agent phase: ${PHASE_LABEL[phase]}${t ? `, started ${t} ago` : ""}`}>
      {PHASE_LABEL[phase]}
      {t && <span className="tk-phase-time"> · {t}</span>}
    </span>
  );
}

function Row({ e, showProject }: { e: AgentEntry; showProject: boolean }) {
  const live = e.view.kind !== "queued" && e.view.kind !== "detached" && e.view.kind !== "failed";
  return (
    <div className={`tka-row tka-${e.view.kind}`}>
      <AgentChip task={e.task} compact />
      <button className="tka-main" onClick={() => e.projectId && openBoard(e.projectId, e.task.id)} title="Open the task">
        <span className="tka-line">
          <span className="tka-id">{e.task.id}</span>
          <span className="tka-title">{e.task.title}</span>
        </span>
        <span className="tka-sub">
          {showProject && <span className="tka-proj">{e.projectName} · </span>}
          {e.view.label}
          {e.view.kind !== "queued" && ` · ${PHASE_LABEL[e.phase]}`}
          {e.since && e.view.kind !== "queued" ? ` · ${elapsed(e.since)}` : ""}
          {e.detail && live && <span className="tka-detail"> · {e.detail}</span>}
        </span>
      </button>
      {live && e.task.paneId && (
        <button className="sb-icon-btn" title="Open agent terminal" aria-label="Open agent terminal" onClick={() => openAgentTerminal(e.root, e.task.id)}>
          <Icon name="terminal" size={14} />
        </button>
      )}
      {(live || e.view.kind === "queued") && (
        <button className="sb-icon-btn" title={e.view.kind === "queued" ? "Remove from queue" : "Stop agent"} aria-label="Stop" onClick={() => void stopAgent(e.root, e.task.id)}>
          <Icon name={e.view.kind === "queued" ? "close" : "stop"} size={14} />
        </button>
      )}
    </div>
  );
}

/** Status bar item "● 2 running · 1 needs you · 3 queued" with a popover per project. */
export function AgentStatusItem() {
  const agents = useAgents();
  const boards = useTasks((s) => s.boards);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const c = summarize(agents);
  const paused = Object.values(boards).some((b) => b.state?.board.settings.paused);
  if (!agents.length && !paused) return null;
  const parts = [
    c.running && `${c.running} running`,
    c.planning && `${c.planning} planning`,
    c.needsYou && `${c.needsYou} need${c.needsYou === 1 ? "s" : ""} you`,
    c.queued && `${c.queued} queued`,
    c.failed && `${c.failed} failed`,
  ].filter(Boolean);
  const groups = new Map<string, AgentEntry[]>();
  for (const e of agents) groups.set(e.root, [...(groups.get(e.root) ?? []), e]);
  const roots = boardRoots();
  return (
    <div className="tka-anchor" ref={ref}>
      <button className={`sb-item clickable${c.needsYou ? " attn" : ""}`} title="Task agents" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ClaudeMark size={11} />
        {parts.length ? parts.join(" · ") : "agents idle"}
        {paused && <span className="sb-sep">· stopped</span>}
      </button>
      {open && (
        <div className="tka-pop" role="dialog" aria-label="Task agents">
          <div className="tka-head">
            <span className="tka-head-title">Task agents</span>
            <span className="sb-spacer" />
            {paused ? (
              <button className="btn small" onClick={() => roots.forEach((r) => void resumeQueue(r))}><Icon name="play" size={12} />Resume all</button>
            ) : (
              <button className="btn small ghost" onClick={() => roots.forEach((r) => void stopAfterCurrent(r))} title="Running agents finish their task; no new ones start, on every board">
                <Icon name="pause" size={12} />Stop all after current
              </button>
            )}
          </div>
          {agents.length === 0 && <div className="tka-empty">No agents are running.</div>}
          {[...groups.entries()].map(([root, list]) => {
            const st = boards[root]?.state;
            return (
              <div key={root} className="tka-group">
                <div className="tka-group-head">
                  <span>{list[0].projectName}</span>
                  {st?.board.settings.paused && <span className="tka-paused">stopped</span>}
                  <span className="sb-spacer" />
                  {st?.board.settings.paused ? (
                    <button className="tk-link" onClick={() => void resumeQueue(root)}>Resume</button>
                  ) : (
                    <button className="tk-link" onClick={() => void stopAfterCurrent(root)}>Stop after current</button>
                  )}
                </div>
                {list.map((e) => <Row key={e.task.id} e={e} showProject={false} />)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Compact strip under the board header: this board's active agents. */
export function AgentStrip({ root }: { root: string }) {
  const agents = useAgents(root).filter((e) => e.view.kind !== "queued");
  if (!agents.length) return null;
  return (
    <div className="tka-strip">
      {agents.map((e) => (
        <button
          key={e.task.id}
          className={`tka-pill tka-${e.view.kind}`}
          title={`${e.task.id} · ${e.task.title}\n${e.view.label} · ${PHASE_LABEL[e.phase]}${e.detail ? `\n${e.detail}` : ""}`}
          onClick={() => !openAgentTerminal(e.root, e.task.id) && e.projectId && openBoard(e.projectId, e.task.id)}
        >
          <AgentChip task={e.task} compact />
          <span className="tka-id">{e.task.id}</span>
          <span>{e.view.kind === "blocked" ? "needs you" : PHASE_LABEL[e.phase]}</span>
          {e.since && <span className="tka-time">{elapsed(e.since)}</span>}
        </button>
      ))}
    </div>
  );
}
