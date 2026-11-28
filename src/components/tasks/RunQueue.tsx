// Run queue panel (board header): auto-pickup, run mode and agent limits, the queue itself
// (drag to reorder, add or remove tasks) with why each task waits, a preview of the start
// groups, and Stop / Resume.
import { useMemo, useState } from "react";
import {
  canQueue, enqueue, queuePreview, reorderQueue, resumeQueue, startNextOnly, stopAfterCurrent, stopAgent, stopAllNow, livePane,
} from "../../tasks/agent";
import { useTasks } from "../../tasks/store";
import type { AutoPickup, BoardSettings, BoardState, PickupPosition } from "../../tasks/types";
import { Icon } from "../icons";
import { CommitInput, Segmented, Select, Toggle } from "../ui";
import { PriorityIcon } from "./parts";

const QUEUE_DRAG = "text/tcon-queue";

/** Running / queued counts and the pause state of a board. */
export function queueCounts(state: BoardState | null) {
  const tasks = state?.tasks ?? [];
  const running = tasks.filter((t) => (t.agent === "running" || t.agent === "blocked") && livePane(t)).length;
  const planning = tasks.filter((t) => t.agent === "planning" && livePane(t)).length;
  const queued = tasks.filter((t) => t.agent === "queued").length;
  return { running, planning, queued, paused: !!state?.board.settings.paused };
}

/** Stop / Resume button for the board header. */
export function QueueControl({ root, state }: { root: string; state: BoardState }) {
  const { running, queued, paused } = queueCounts(state);
  if (!paused && running === 0 && queued === 0) return null;
  if (paused) {
    return (
      <span className="tkq-control">
        <span className="tkq-state" title={running ? "Running agents finish their task; no new ones start" : "No new agents start"}>
          {running ? `Stopping… (${running} running)` : `Stopped · ${queued} waiting`}
        </span>
        <button className="btn small" onClick={() => void resumeQueue(root)} title="Start queued tasks again">
          <Icon name="play" size={12} />Resume
        </button>
        {queued > 0 && <button className="btn small ghost" onClick={() => void startNextOnly(root)} title="Start exactly one queued task, then stay stopped">Next only</button>}
      </span>
    );
  }
  return (
    <button className="btn small ghost" onClick={() => void stopAfterCurrent(root)} title="Let running agents finish their task, start no new ones">
      <Icon name="pause" size={12} />Stop after current
    </button>
  );
}

export function RunQueuePanel({ root, state, onClose }: { root: string; state: BoardState; onClose(): void }) {
  const s = state.board.settings;
  const save = (patch: Partial<BoardSettings>) => void useTasks.getState().saveSettings(root, patch);
  const preview = useMemo(() => queuePreview(state), [state]);
  const byId = useMemo(() => new Map(state.tasks.map((t) => [t.id, t])), [state]);
  const { running, queued, paused } = queueCounts(state);
  const [drop, setDrop] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const todoIdle = (state.columns.todo ?? []).filter((id) => {
    const t = byId.get(id);
    return t && (t.agent === "idle" || t.agent === "done" || t.agent === "failed" || !t.agent);
  });
  // Tasks that can join the queue, grouped by column in board order.
  const addable = state.board.columns
    .map((c) => ({ col: c, tasks: (state.columns[c.id] ?? []).map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t && canQueue(t)) }))
    .filter((g) => g.tasks.length);
  const parallel = (s.runMode !== "rolling" || s.maxAgents > 1) && s.isolation !== "worktree";

  const onDrop = (e: React.DragEvent, index: number) => {
    const id = e.dataTransfer.getData(QUEUE_DRAG);
    setDrop(null);
    if (!id) return;
    e.preventDefault();
    const order = preview.order.filter((x) => x !== id);
    const from = preview.order.indexOf(id);
    order.splice(from >= 0 && from < index ? index - 1 : index, 0, id);
    void reorderQueue(root, order);
  };

  return (
    <div className="tkq" role="dialog" aria-label="Run queue" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="tkq-head">
        <Icon name="queue" size={14} />
        <span className="tkq-title">Run queue</span>
        <span className="tkq-sub">{running} running · {queued} queued{paused ? " · stopped" : ""}</span>
        <span className="sb-spacer" />
        <button className="sb-icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>

      <div className="tkq-grid">
        <span className="tkq-label" title="What happens when a task enters Todo">When a task enters Todo</span>
        <Segmented<AutoPickup>
          ariaLabel="Auto-pickup"
          value={s.autoPickup}
          onChange={(v) => save({ autoPickup: v })}
          options={[
            { value: "off", label: "Nothing" },
            { value: "ask", label: "Ask", title: "Ask whether Claude should start on it" },
            { value: "auto", label: "Queue it", title: "Add it to the run queue and start when there's room" },
          ]}
        />
        <span className="tkq-label">New tasks join the queue</span>
        <Select ariaLabel="Queue position" value={s.pickupPosition} onChange={(v) => save({ pickupPosition: v as PickupPosition })}>
          <option value="end">At the end</option>
          <option value="front">At the front</option>
          <option value="priority">By priority</option>
        </Select>
        <span className="tkq-label" title="New Inbox cards get a planning agent that writes a plan and moves them to Todo">Plan new Inbox cards</span>
        <Toggle checked={s.inboxAutoPlan} onChange={(v) => save({ inboxAutoPlan: v })} />
        <span className="tkq-label">Run mode</span>
        <Segmented<BoardSettings["runMode"]>
          ariaLabel="Run mode"
          value={s.runMode}
          onChange={(v) => save({ runMode: v })}
          options={[
            { value: "rolling", label: "Rolling", title: "Keep up to the agent limit busy, in queue order" },
            { value: "batch", label: "Batches", title: "Start a batch, wait until all of it is done, then the next" },
            { value: "parallel-safe", label: "Parallel-safe", title: "Start tasks together whose plans touch different files" },
          ]}
        />
        {s.runMode === "batch" ? (
          <>
            <span className="tkq-label">Batch size</span>
            <Select ariaLabel="Batch size" value={String(s.batchSize)} onChange={(v) => save({ batchSize: Number(v) })}>
              {[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n} at a time</option>)}
            </Select>
          </>
        ) : (
          <>
            <span className="tkq-label">Agents at a time</span>
            <Select ariaLabel="Agents at a time" value={String(s.maxAgents)} onChange={(v) => save({ maxAgents: Number(v) })}>
              {[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </>
        )}
        <span className="tkq-label" title="When an agent's session was cut off (tCon closed, the Mac restarted)">Interrupted agents</span>
        <Segmented<BoardSettings["resumeInterrupted"]>
          ariaLabel="Interrupted agents"
          value={s.resumeInterrupted}
          onChange={(v) => save({ resumeInterrupted: v })}
          options={[
            { value: "ask", label: "Ask to resume" },
            { value: "auto", label: "Resume automatically" },
          ]}
        />
        <span className="tkq-label" title="Each agent works on its own branch (tcon/T-n) in a separate git worktree">Isolation</span>
        <Segmented<BoardSettings["isolation"]>
          ariaLabel="Isolation"
          value={s.isolation}
          onChange={(v) => save({ isolation: v })}
          options={[
            { value: "none", label: "Same checkout" },
            { value: "worktree", label: "Worktree per task", title: "Branch tcon/T-n in ~/.tcon/worktrees; merge or open a PR from the task" },
          ]}
        />
        {s.isolation === "worktree" && (
          <>
            <span className="tkq-label" title="Runs in each new worktree before the agent starts">Worktree setup</span>
            <CommitInput value={s.worktreeSetup} placeholder="e.g. npm ci" onCommit={(v) => save({ worktreeSetup: v })} />
            <span className="tkq-label">Share node_modules</span>
            <Toggle checked={s.linkNodeModules} onChange={(v) => save({ linkNodeModules: v })} />
          </>
        )}
      </div>

      {parallel && (
        <div className="tkq-warn">
          Several agents share one working tree and branch, so their changes and commits can mix.
          Use <b>Worktree per task</b>, <b>Parallel-safe</b> with triaged plans, or one agent at a time.
        </div>
      )}

      <div className="tkq-list" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}>
        {preview.order.length === 0 && <div className="tkq-empty">The queue is empty.</div>}
        {preview.order.map((id, i) => {
          const t = byId.get(id);
          if (!t) return null;
          const group = preview.groups.findIndex((g) => g.includes(id));
          return (
            <div
              key={id}
              className={`tkq-row${drop === i ? " drop-before" : ""}${drop === i + 1 && i === preview.order.length - 1 ? " drop-after" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(QUEUE_DRAG, id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(QUEUE_DRAG)) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDrop(e.clientY > r.top + r.height / 2 ? i + 1 : i);
              }}
              onDrop={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onDrop(e, e.clientY > r.top + r.height / 2 ? i + 1 : i);
              }}
            >
              <span className="tkq-pos">{i + 1}</span>
              <PriorityIcon priority={t.priority} size={12} />
              <span className="tkq-id">{t.id}</span>
              <span className="tkq-name" title={t.title}>{t.title}</span>
              <span className="sb-spacer" />
              <span className="tkq-why" title={preview.waiting.get(id)}>
                {group === 0 && !paused ? "Starts now" : group > 0 ? `Group ${group + 1}` : preview.waiting.get(id) ?? ""}
              </span>
              <button className="sb-icon-btn" aria-label={`Remove ${t.id} from the queue`} title="Remove from queue" onClick={() => void stopAgent(root, id)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {addable.length > 0 && (
        <div className="tkq-add">
          <Icon name="plus" size={12} />
          <Select
            ariaLabel="Add a task to the queue"
            title={`Adds the task ${s.pickupPosition === "front" ? "at the front of" : s.pickupPosition === "priority" ? "by priority to" : "at the end of"} the queue`}
            value=""
            onChange={(id) => id && void enqueue(root, [id])}
          >
            <option value="" disabled>Add a task to the queue…</option>
            {addable.map((g) => (
              <optgroup key={g.col.id} label={g.col.title}>
                {g.tasks.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}
              </optgroup>
            ))}
          </Select>
        </div>
      )}

      <div className="tkq-foot">
        {todoIdle.length > 0 && (
          <button className="btn small" onClick={() => void enqueue(root, todoIdle, "end")} title="Add every Todo task without an agent to the queue">
            <Icon name="plus" size={12} />Queue all Todo ({todoIdle.length})
          </button>
        )}
        <span className="sb-spacer" />
        {confirmStop ? (
          <span className="tkq-confirm">
            Stop {running} running agent{running === 1 ? "" : "s"} now?
            <button className="btn small danger" onClick={() => { setConfirmStop(false); void stopAllNow(root); }}>Stop all</button>
            <button className="btn small ghost" onClick={() => setConfirmStop(false)}>Cancel</button>
          </span>
        ) : (
          <>
            {running > 0 && <button className="btn small ghost" onClick={() => setConfirmStop(true)}>Stop all now</button>}
            {paused ? (
              <button className="btn small primary" onClick={() => void resumeQueue(root)}><Icon name="play" size={12} />Start queue</button>
            ) : (
              <button className="btn small" onClick={() => void stopAfterCurrent(root)}><Icon name="pause" size={12} />Stop after current</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
