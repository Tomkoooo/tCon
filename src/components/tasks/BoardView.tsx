// Full kanban board, opened as an editor tab ("board" kind). Columns with drag & drop, inline add
// per column, a detail drawer, and keyboard control: N new card, arrows move the selection,
// Enter opens, Esc closes, / filters.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../types";
import { useBoard, useTasks } from "../../tasks/store";
import { livePane, startAgent } from "../../tasks/agent";
import type { Task } from "../../tasks/types";
import { useContextMenu } from "../ContextMenu";
import { boardMenuItems, taskMenuItems } from "./TasksView";
import { TaskDrawer } from "./TaskDrawer";
import {
  AgentChip, ClaudeMark, Labels, PriorityIcon, StatusIcon, TASK_DRAG, adjustedIndex, dropIndexFor, readDrag, relTime, type DragPayload,
} from "./parts";
import { Icon } from "../icons";
import { QueueControl, RunQueuePanel, queueCounts } from "./RunQueue";
import { BulkBar } from "./BulkBar";
import "./tasks.css";

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

function matches(t: Task, q: string) {
  if (!q) return true;
  const s = q.toLowerCase();
  return t.title.toLowerCase().includes(s) || t.id.toLowerCase().includes(s) || t.labels.some((l) => l.toLowerCase().includes(s)) || t.description.toLowerCase().includes(s);
}

export function BoardView({ project }: { project: Project }) {
  const root = project.rootPath;
  const { state, error, loading } = useBoard(root);
  const openId = useTasks((s) => s.openTask[root.replace(/\/+$/, "")] ?? null);
  const setOpenTask = useTasks((s) => s.setOpenTask);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [drop, setDrop] = useState<{ column: string; index: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  /** multi-selection (⌘/Ctrl-click, ⇧-click, ⌘A); `selected` stays the focused card */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const menu = useContextMenu();

  const byId = useMemo(() => new Map((state?.tasks ?? []).map((t) => [t.id, t])), [state]);
  const columns = state?.board.columns ?? [];
  const visible = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of columns) out[c.id] = (state?.columns[c.id] ?? []).filter((id) => byId.has(id) && matches(byId.get(id)!, filter));
    return out;
  }, [state, columns, byId, filter]);

  const openTask = openId ? byId.get(openId) ?? null : null;
  useEffect(() => {
    // Keyboard-ready as soon as the board opens (unless a drawer takes focus).
    if (!useTasks.getState().openTask[root.replace(/\/+$/, "")]) rootRef.current?.focus();
  }, [root]);
  useEffect(() => {
    if (openId) setSelected(openId);
  }, [openId]);

  const counts = useMemo(() => {
    const ts = state?.tasks ?? [];
    return {
      open: ts.filter((t) => t.status !== "done").length,
      agents: ts.filter((t) => (t.agent === "running" || t.agent === "blocked") && livePane(t)).length,
      queued: ts.filter((t) => t.agent === "queued").length,
    };
  }, [state]);

  const focusBoard = () => requestAnimationFrame(() => rootRef.current?.focus());
  const close = () => {
    setOpenTask(root, null);
    focusBoard();
  };

  const locate = (id: string | null): [number, number] | null => {
    if (!id) return null;
    for (let ci = 0; ci < columns.length; ci++) {
      const ri = visible[columns[ci].id]?.indexOf(id) ?? -1;
      if (ri >= 0) return [ci, ri];
    }
    return null;
  };

  // Drop ids that disappeared (deleted, filtered out).
  useEffect(() => {
    setPicked((p) => {
      const all = new Set(Object.values(visible).flat());
      const next = new Set([...p].filter((id) => all.has(id)));
      return next.size === p.size ? p : next;
    });
  }, [visible]);

  const clickCard = (e: React.MouseEvent, colId: string, id: string) => {
    if (e.metaKey || e.ctrlKey) {
      setPicked((p) => {
        const next = new Set(p);
        if (!next.size && selected && selected !== id) next.add(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelected(id);
      return;
    }
    if (e.shiftKey && selected) {
      const ids = visible[colId] ?? [];
      const a = ids.indexOf(selected);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        setPicked(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return;
      }
    }
    setPicked(new Set());
    setSelected(id);
    setOpenTask(root, id);
  };

  const selectColumn = (colId: string, on: boolean) => {
    const ids = visible[colId] ?? [];
    setPicked((p) => {
      const next = new Set(p);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!isTyping(e.target) && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "a") {
      // ⌘A: every card of the focused column (or of the first non-empty one).
      e.preventDefault();
      const pos = locate(selected);
      const col = pos ? columns[pos[0]] : columns.find((c) => visible[c.id]?.length);
      if (col) setPicked(new Set(visible[col.id] ?? []));
      return;
    }
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const pos = locate(selected);
    const firstNonEmpty = () => columns.findIndex((c) => visible[c.id]?.length);
    const moveSel = (ci: number, ri: number) => {
      const col = columns[ci];
      const ids = col ? visible[col.id] : undefined;
      if (!ids?.length) return false;
      setSelected(ids[Math.max(0, Math.min(ri, ids.length - 1))]);
      return true;
    };
    switch (e.key) {
      case "n":
      case "N":
        e.preventDefault();
        setAdding(pos ? columns[pos[0]].id : columns[0]?.id ?? "inbox");
        break;
      case "/":
        e.preventDefault();
        filterRef.current?.focus();
        break;
      case "Enter":
        if (selected) {
          e.preventDefault();
          setOpenTask(root, selected);
        }
        break;
      case "Escape":
        if (picked.size) setPicked(new Set());
        else if (queueOpen) setQueueOpen(false);
        else if (openTask) close();
        else if (adding) setAdding(null);
        else setSelected(null);
        break;
      case "ArrowDown":
      case "j":
        e.preventDefault();
        if (!pos) moveSel(Math.max(0, firstNonEmpty()), 0);
        else moveSel(pos[0], pos[1] + 1);
        break;
      case "ArrowUp":
      case "k":
        e.preventDefault();
        if (!pos) moveSel(Math.max(0, firstNonEmpty()), 0);
        else moveSel(pos[0], pos[1] - 1);
        break;
      case "ArrowRight":
      case "ArrowLeft":
      case "l":
      case "h": {
        e.preventDefault();
        const dir = e.key === "ArrowRight" || e.key === "l" ? 1 : -1;
        if (!pos) {
          moveSel(Math.max(0, firstNonEmpty()), 0);
          break;
        }
        if (e.shiftKey && selected) {
          // ⇧←/→ moves the card to the neighbouring column.
          const to = columns[pos[0] + dir];
          if (to) void useTasks.getState().move(root, selected, to.id, Number.MAX_SAFE_INTEGER);
          break;
        }
        for (let ci = pos[0] + dir; ci >= 0 && ci < columns.length; ci += dir) if (moveSel(ci, pos[1])) break;
        break;
      }
      case "c":
        if (selected) {
          e.preventDefault();
          void startAgent(root, selected);
        }
        break;
    }
  };

  const onDrop = (e: React.DragEvent, column: string, index: number) => {
    const d = readDrag(e);
    setDrop(null);
    setDraggingId(null);
    if (!d || d.root !== root) return;
    e.preventDefault();
    // Indices are positions in the (possibly filtered) visible list; map to the full column.
    const full = state?.columns[column] ?? [];
    const vis = visible[column] ?? [];
    const anchor = vis[index];
    let fullIndex = anchor !== undefined ? full.indexOf(anchor) : full.length;
    const from: DragPayload = { ...d, index: (state?.columns[d.column] ?? []).indexOf(d.id) };
    if (fullIndex < 0) fullIndex = full.length;
    void useTasks.getState().move(root, d.id, column, adjustedIndex(from, column, fullIndex));
    setSelected(d.id);
  };

  return (
    <div className="tkb" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="tkb-header">
        <div className="tkb-title">
          <span className="tkb-name">{project.name}</span>
        </div>
        <div className="tkb-stats">
          <span>{counts.open} open</span>
          {counts.agents > 0 && <span className="tkb-stat-agents"><ClaudeMark size={11} />{counts.agents} agent{counts.agents > 1 ? "s" : ""} running</span>}
          {counts.queued > 0 && <span>{counts.queued} queued</span>}
        </div>
        <span className="sb-spacer" />
        <div className="tkb-filter">
          <Icon name="search" size={14} />
          <input
            ref={filterRef}
            placeholder="Filter"
            aria-label="Filter tasks"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                focusBoard();
              } else if (e.key === "Enter") focusBoard();
            }}
          />
        </div>
        {state && <QueueControl root={root} state={state} />}
        {state && (
          <button
            className={`btn small ghost${queueOpen ? " on" : ""}`}
            title="Run queue: auto-pickup, run mode, order"
            aria-expanded={queueOpen}
            onClick={() => setQueueOpen((v) => !v)}
          >
            <Icon name="queue" size={14} />
            Queue{queueCounts(state).queued > 0 ? ` · ${queueCounts(state).queued}` : ""}
            {state.board.settings.autoPickup === "auto" && <span className="tkb-auto-badge" title="Tasks entering Todo are queued automatically">auto</span>}
          </button>
        )}
        <button className="btn small primary" title="New task (N)" onClick={() => setAdding(columns[0]?.id ?? "inbox")}>
          <Icon name="plus" size={14} />
          New task
        </button>
        <button className="icon-btn" title="Board settings" aria-label="Board settings" onClick={(e) => menu.open(e, boardMenuItems(root, state, { inBoard: true }))}>
          <Icon name="more" />
        </button>
      </div>

      {error && <div className="tkb-error">{error}</div>}
      {!state && loading && <div className="tkb-empty">Loading…</div>}

      {state && (
        <div className="tkb-columns" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}>
          {columns.map((col) => {
            const ids = visible[col.id] ?? [];
            return (
              <div
                key={col.id}
                className={`tkb-col tkb-col-${col.id}${drop?.column === col.id ? " tkb-col-drop" : ""}`}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(TASK_DRAG)) return;
                  e.preventDefault();
                  if (drop?.column !== col.id || drop.index !== ids.length) setDrop({ column: col.id, index: ids.length });
                }}
                onDrop={(e) => onDrop(e, col.id, ids.length)}
              >
                <div className="tkb-col-header">
                  <StatusIcon status={col.id} />
                  <span className="tkb-col-title">{col.title}</span>
                  {ids.length > 0 && (
                    <input
                      type="checkbox"
                      className="tkb-col-check"
                      title={`Select all in ${col.title}`}
                      aria-label={`Select all in ${col.title}`}
                      checked={ids.every((id) => picked.has(id))}
                      onChange={(e) => selectColumn(col.id, e.target.checked)}
                    />
                  )}
                  <span className="tkb-col-count">{ids.length}</span>
                  <span className="sb-spacer" />
                  <button className="sb-icon-btn" title={`Add to ${col.title}`} aria-label={`Add to ${col.title}`} onClick={() => setAdding(col.id)}>
                    <Icon name="plus" size={14} />
                  </button>
                </div>
                <div className="tkb-cards">
                  {adding === col.id && (
                    <InlineAdd
                      onCancel={() => {
                        setAdding(null);
                        focusBoard();
                      }}
                      onAdd={async (title, keepOpen) => {
                        const t = await useTasks.getState().capture(root, title, "", col.id);
                        // Adding another: keep the input in view instead of scrolling to the new card.
                        if (t && !keepOpen) setSelected(t.id);
                        if (!keepOpen) {
                          setAdding(null);
                          focusBoard();
                        }
                      }}
                    />
                  )}
                  {ids.map((id, i) => {
                    const t = byId.get(id)!;
                    return (
                      <Card
                        key={id}
                        task={t}
                        selected={selected === id}
                        multi={picked.has(id)}
                        dragging={draggingId === id}
                        dropBefore={drop?.column === col.id && drop.index === i}
                        dropAfter={drop?.column === col.id && drop.index === i + 1 && i === ids.length - 1}
                        onSelect={(e) => clickCard(e, col.id, id)}
                        onMenu={(e) => {
                          setSelected(id);
                          menu.open(e, taskMenuItems(root, t, state, { open: () => setOpenTask(root, id) }));
                        }}
                        onDragStart={(e) => {
                          const payload: DragPayload = { root, id, column: col.id, index: i };
                          e.dataTransfer.setData(TASK_DRAG, JSON.stringify(payload));
                          e.dataTransfer.effectAllowed = "move";
                          setDraggingId(id);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDrop(null);
                        }}
                        onDragOver={(e) => {
                          if (!e.dataTransfer.types.includes(TASK_DRAG)) return;
                          e.preventDefault();
                          e.stopPropagation();
                          const index = dropIndexFor(e, e.currentTarget, i);
                          if (drop?.column !== col.id || drop.index !== index) setDrop({ column: col.id, index });
                        }}
                        onDrop={(e) => {
                          e.stopPropagation();
                          onDrop(e, col.id, dropIndexFor(e, e.currentTarget, i));
                        }}
                      />
                    );
                  })}
                  {ids.length === 0 && adding !== col.id && (
                    <button className="tkb-col-empty" onClick={() => setAdding(col.id)}>
                      {filter ? "No matches" : "No tasks"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="tkb-hints">
        <span><kbd>N</kbd> new</span>
        <span><kbd>↑↓←→</kbd> select</span>
        <span><kbd>⇧←→</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>C</kbd> Claude</span>
        <span><kbd>⌘</kbd>/<kbd>⇧</kbd>click, <kbd>⌘A</kbd> multi-select</span>
        <span><kbd>/</kbd> filter</span>
        <span><kbd>Esc</kbd> close</span>
      </div>

      {state && picked.size > 0 && <BulkBar root={root} state={state} ids={[...picked]} onClear={() => { setPicked(new Set()); focusBoard(); }} />}
      {queueOpen && state && <RunQueuePanel root={root} state={state} onClose={() => { setQueueOpen(false); focusBoard(); }} />}
      {openTask && state && <TaskDrawer key={openTask.id} root={root} task={openTask} state={state} onClose={close} />}
      {menu.element}
    </div>
  );
}

function Card(props: {
  task: Task;
  selected: boolean;
  multi: boolean;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onSelect(e: React.MouseEvent): void;
  onMenu(e: React.MouseEvent): void;
  onDragStart(e: React.DragEvent): void;
  onDragEnd(): void;
  onDragOver(e: React.DragEvent): void;
  onDrop(e: React.DragEvent): void;
}) {
  const { task } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [props.selected]);
  const hasNotes = task.description.trim().length > 0;
  return (
    <div
      ref={ref}
      className={`tkb-card${props.selected ? " selected" : ""}${props.multi ? " multi" : ""}${props.dragging ? " dragging" : ""}${props.dropBefore ? " drop-before" : ""}${props.dropAfter ? " drop-after" : ""}${task.status === "done" ? " done" : ""}`}
      draggable
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onClick={props.onSelect}
      onContextMenu={props.onMenu}
    >
      <div className="tkb-card-top">
        <PriorityIcon priority={task.priority} size={13} />
        <span className="tkb-card-id">{task.id}</span>
        <span className="sb-spacer" />
        <AgentChip task={task} />
      </div>
      <div className="tkb-card-title">{task.title || "Untitled"}</div>
      {(task.labels.length > 0 || hasNotes || task.commits.length > 0) && (
        <div className="tkb-card-meta">
          <Labels labels={task.labels} />
          <span className="sb-spacer" />
          {hasNotes && (
            <span className="tkb-card-icon" title="Has notes">
              <Icon name="notes" size={12} />
            </span>
          )}
          {task.commits.length > 0 && (
            <span className="tkb-card-icon" title={task.commits.join(", ")}>
              <Icon name="commit" size={12} />
              {task.commits.length}
            </span>
          )}
        </div>
      )}
      <div className="tkb-card-foot" title={`Updated ${task.updated}`}>{relTime(task.updated || task.created)}</div>
    </div>
  );
}

function InlineAdd({ onAdd, onCancel }: { onAdd(title: string, keepOpen: boolean): Promise<void>; onCancel(): void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState(0);
  // Keep the input visible while adding several cards in a row.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [added]);
  return (
    <div className="tkb-card tkb-inline-add" ref={ref}>
      <textarea
        autoFocus
        rows={2}
        placeholder="Task title (#label !high · ↵ add, ⇧↵ add another)"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => !v.trim() && onCancel()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const t = v.trim();
            if (!t) return onCancel();
            setV("");
            void onAdd(t, e.shiftKey).then(() => setAdded((n) => n + 1));
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
    </div>
  );
}
