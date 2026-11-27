// Floating bar for multi-selected cards (board and Tasks sidebar): plan with Claude, start,
// add to the run queue, set priority, move, delete (with an in-app confirmation).
import { useState } from "react";
import { enqueue, planTasks, startAgent } from "../../tasks/agent";
import { useTasks } from "../../tasks/store";
import { PRIORITIES, type BoardState } from "../../tasks/types";
import { Icon } from "../icons";
import { Select } from "../ui";
import { ClaudeMark } from "./parts";

export function BulkBar({ root, state, ids, onClear, compact }: { root: string; state: BoardState; ids: string[]; onClear(): void; compact?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  if (!ids.length) return null;
  const store = useTasks.getState();
  const open = ids.filter((id) => state.tasks.find((t) => t.id === id)?.status !== "done");
  const run = (fn: () => Promise<unknown>) => () => {
    void fn();
    onClear();
  };
  return (
    <div className={`tk-bulk${compact ? " compact" : ""}`} role="toolbar" aria-label={`${ids.length} selected`}>
      <span className="tk-bulk-count">{ids.length} selected</span>
      {confirm ? (
        <>
          <span className="tk-bulk-warn">Delete {ids.length} task file{ids.length === 1 ? "" : "s"}?</span>
          <button className="btn small danger" onClick={run(() => store.bulk(root, ids.map((id) => ({ id, delete: true }))))}>Delete</button>
          <button className="btn small ghost" onClick={() => setConfirm(false)}>Cancel</button>
        </>
      ) : (
        <>
          <button className="btn small" disabled={!open.length} title="Plan the selected tasks and move them to Todo, without changing code" onClick={run(() => planTasks(root, open))}>
            <Icon name="notes" size={12} />{compact ? "Plan" : "Plan with Claude"}
          </button>
          <button className="btn small" disabled={!open.length} title="Start Claude on each (queued when the agent limit is reached)" onClick={run(async () => {
            for (const id of open) await startAgent(root, id);
          })}>
            <ClaudeMark size={11} />{compact ? "Start" : "Start Claude"}
          </button>
          <button className="btn small" disabled={!open.length} title="Add to the run queue" onClick={run(() => enqueue(root, open))}>
            <Icon name="queue" size={12} />{compact ? "Queue" : "Add to queue"}
          </button>
          <Select ariaLabel="Set priority" value="" onChange={(v) => v && run(() => store.bulk(root, ids.map((id) => ({ id, patch: { priority: v } }))))()}>
            <option value="" disabled>Priority…</option>
            {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
          <Select ariaLabel="Move to column" value="" onChange={(v) => v && run(() => store.bulk(root, ids.map((id) => ({ id, column: v }))))()}>
            <option value="" disabled>Move to…</option>
            {state.board.columns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </Select>
          <button className="btn small ghost danger" title="Delete the selected tasks" aria-label="Delete the selected tasks" onClick={() => setConfirm(true)}>
            <Icon name="discard" size={12} />
          </button>
        </>
      )}
      <span className="sb-spacer" />
      <button className="sb-icon-btn" title="Clear selection (Esc)" aria-label="Clear selection" onClick={onClear}><Icon name="close" size={12} /></button>
    </div>
  );
}
