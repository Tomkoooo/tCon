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

  const onKeyDown = (e: React.KeyboardEvent) => {
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
        if (openTask) close();
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
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M6 2.5v11M10.5 2.5v6" />
          </svg>
          <span>{project.name}</span>
          <span className="tkb-sub">Tasks</span>
        </div>
        <div className="tkb-stats">
          <span>{counts.open} open</span>
          {counts.agents > 0 && <span className="tkb-stat-agents"><ClaudeMark size={10} /> {counts.agents} agent{counts.agents > 1 ? "s" : ""} running</span>}
          {counts.queued > 0 && <span>{counts.queued} queued</span>}
        </div>
        <span className="sb-spacer" />
        <div className="tkb-filter">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
          <input
            ref={filterRef}
            placeholder="Filter  /"
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
        {state && (
          <button
            className={`tkb-toggle${state.board.settings.askOnTodo ? " on" : ""}`}
            title="When a task enters Todo, ask whether Claude should start working on it"
            onClick={() => void useTasks.getState().saveSettings(root, { askOnTodo: !state.board.settings.askOnTodo })}
          >
            <span className="tkb-switch" /> Auto-pickup
          </button>
        )}
        <button className="tkb-btn" title="New task (N)" onClick={() => setAdding(columns[0]?.id ?? "inbox")}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 3v10M3 8h10" /></svg>
          New
        </button>
        <button className="sb-icon-btn" title="Board settings" onClick={(e) => menu.open(e, boardMenuItems(root, state))}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>
        </button>
      </div>

      {error && <div className="tkb-error">{error}</div>}
      {!state && loading && <div className="tkb-empty">Loading board…</div>}

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
                  <span className="tkb-col-count">{ids.length}</span>
                  <span className="sb-spacer" />
                  <button className="sb-icon-btn" title={`Add to ${col.title}`} onClick={() => setAdding(col.id)}>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v10M3 8h10" /></svg>
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
                        const t = await useTasks.getState().create(root, title, "", col.id);
                        if (t) setSelected(t.id);
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
                        dragging={draggingId === id}
                        dropBefore={drop?.column === col.id && drop.index === i}
                        dropAfter={drop?.column === col.id && drop.index === i + 1 && i === ids.length - 1}
                        onSelect={() => {
                          setSelected(id);
                          setOpenTask(root, id);
                        }}
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
                      {filter ? "No matches" : col.id === "inbox" ? "Drop notes here, or press N" : "No tasks"}
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
        <span><kbd>/</kbd> filter</span>
        <span><kbd>Esc</kbd> close</span>
      </div>

      {openTask && state && <TaskDrawer key={openTask.id} root={root} task={openTask} state={state} onClose={close} />}
      {menu.element}
    </div>
  );
}

function Card(props: {
  task: Task;
  selected: boolean;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onSelect(): void;
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
      className={`tkb-card${props.selected ? " selected" : ""}${props.dragging ? " dragging" : ""}${props.dropBefore ? " drop-before" : ""}${props.dropAfter ? " drop-after" : ""}${task.status === "done" ? " done" : ""}`}
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
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
            </span>
          )}
          {task.commits.length > 0 && (
            <span className="tkb-card-icon" title={task.commits.join(", ")}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="2.5" /><path d="M1 8h4.5M10.5 8H15" /></svg>
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
  return (
    <div className="tkb-card tkb-inline-add">
      <textarea
        autoFocus
        rows={2}
        placeholder="Task title… ↵ add · ⇧↵ add another · Esc cancel"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => !v.trim() && onCancel()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const t = v.trim();
            if (!t) return onCancel();
            setV("");
            void onAdd(t, e.shiftKey);
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
