// Sidebar "Tasks" view: always-ready quick capture on top, then a compact list grouped by column
// with drag & drop. Built for jotting things down fast during a meeting.
import { useEffect, useMemo, useRef, useState } from "react";
import { useBoard, useTasks } from "../../tasks/store";
import { installSkill, openAgentTerminal, planTasks, projectForRoot, resumeQueue, startAgent, stopAfterCurrent, stopAgent, livePane } from "../../tasks/agent";
import { openBoard, quickAddTask } from "../../tasks/actions";
import { DEFAULT_SETTINGS, PRIORITIES, type AutoPickup, type BoardState, type Task } from "../../tasks/types";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import {
  AgentChip, ClaudeMark, PriorityIcon, StatusIcon, TASK_DRAG, adjustedIndex, dropIndexFor, readDrag, useAgentView, type DragPayload,
} from "./parts";
import { Icon } from "../icons";
import { BulkBar } from "./BulkBar";
import "./tasks.css";

const COLLAPSE_KEY = "tcon.tasks.collapsed";
function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "") ?? { done: true };
  } catch {
    return { done: true };
  }
}

// ---------------- shared menus ----------------

/** Board settings menu (sidebar title, board header). The board header has its own run
 *  queue panel, so `inBoard` leaves the queue items out. */
export function boardMenuItems(root: string, state: BoardState | null, opts: { inBoard?: boolean } = {}): MenuItem[] {
  const st = useTasks.getState();
  const s = state?.board.settings ?? DEFAULT_SETTINGS;
  const pickup: [AutoPickup, string][] = [["off", "Do Nothing"], ["ask", "Ask to Start Claude"], ["auto", "Queue for Claude Automatically"]];
  return [
    ...(opts.inBoard ? [] : [
      { header: "When a task enters Todo" },
      ...pickup.map(([v, label]) => ({ label, checked: s.autoPickup === v, action: () => void st.saveSettings(root, { autoPickup: v }) })),
      { label: "Plan New Inbox Cards with Claude", checked: s.inboxAutoPlan, action: () => void st.saveSettings(root, { inboxAutoPlan: !s.inboxAutoPlan }) },
      "sep" as const,
      s.paused
        ? { label: "Resume Queue", action: () => void resumeQueue(root) }
        : { label: "Stop Queue After Current Tasks", action: () => void stopAfterCurrent(root) },
      "sep" as const,
    ]),
    { header: "Concurrent agents" },
    ...[1, 2, 3, 4].map((n) => ({
      label: `${n} at a time`,
      checked: s.maxAgents === n,
      action: () => void st.saveSettings(root, { maxAgents: n }),
    })),
    "sep",
    {
      label: "Share Board via Git",
      checked: s.shared,
      title: s.shared ? undefined : "Off: .tcon/ is listed in .git/info/exclude",
      action: () => void st.saveSettings(root, { shared: !s.shared }),
    },
    {
      label: "Install tCon Task Skill",
      checked: false,
      action: () =>
        void installSkill()
          .then((paths) => st.setNotice(`Installed the tcon-tasks skill (${paths.length} location${paths.length === 1 ? "" : "s"}).`))
          .catch((e) => st.setNotice(`Couldn't install the skill: ${e}`, true)),
    },
    { label: "Plan Inbox with Claude", title: "Plan every Inbox card and move it to Todo, without changing code", action: () => void planTasks(root, state?.columns.inbox ?? []) },
    { label: "Reload Tasks", checked: false, action: () => void st.load(root) },
  ];
}

/** Per-task context menu (sidebar rows, board cards). */
export function taskMenuItems(root: string, task: Task, state: BoardState | null, extra: { open?: () => void } = {}): MenuItem[] {
  const st = useTasks.getState();
  const alive = !!livePane(task);
  const running = task.agent === "running" || task.agent === "blocked" || task.agent === "queued" || task.agent === "planning";
  const items: MenuItem[] = [];
  if (extra.open) items.push({ label: "Open", hint: "↵", action: extra.open });
  items.push(running && (alive || task.agent === "queued")
    ? { label: task.agent === "queued" ? "Remove from Agent Queue" : task.agent === "planning" ? "Stop Planner" : "Stop Agent", action: () => void stopAgent(root, task.id) }
    : { label: "Let Claude Work on This", action: () => void startAgent(root, task.id) });
  if (!running && task.status !== "done") items.push({ label: "Plan with Claude", title: "Write a plan and move it to Todo, without changing code", action: () => void planTasks(root, [task.id]) });
  if (alive) items.push({ label: "Open Agent Terminal", action: () => openAgentTerminal(root, task.id) });
  items.push("sep");
  for (const c of state?.board.columns ?? []) {
    if (c.id !== task.status) items.push({ label: `Move to ${c.title}`, action: () => void st.move(root, task.id, c.id, Number.MAX_SAFE_INTEGER) });
  }
  items.push("sep", { header: "Priority" });
  for (const p of PRIORITIES) {
    items.push({ label: p.label, checked: task.priority === p.id, action: () => void st.update(root, task.id, { priority: p.id }) });
  }
  items.push("sep", { label: "Delete Task", action: () => void confirmDelete(root, task) });
  return items;
}

export async function confirmDelete(root: string, task: Task) {
  if (!window.confirm(`Delete ${task.id} "${task.title}"? This deletes .tcon/tasks/${task.id}.md.`)) return;
  if (livePane(task)) await stopAgent(root, task.id);
  await useTasks.getState().remove(root, task.id);
}

/** Buttons shown in the sidebar title row while the Tasks view is active. */
export function TasksTitleActions({ root }: { root: string }) {
  const { state } = useBoard(root);
  const menu = useContextMenu();
  const project = projectForRoot(root);
  return (
    <span className="tk-title-actions">
      {project && (
        <button className="sb-icon-btn" title="Open board" aria-label="Open board" onClick={() => openBoard(project.id)}>
          <Icon name="board" />
        </button>
      )}
      <button className="sb-icon-btn" title="Board settings" aria-label="Board settings" onClick={(e) => menu.open(e, boardMenuItems(root, state))}>
        <Icon name="more" />
      </button>
      {menu.element}
    </span>
  );
}

// ---------------- capture ----------------

export function QuickCapture({ root, column = "inbox", autoFocusAt }: { root: string; column?: string; autoFocusAt?: number }) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [target, setTarget] = useState(column);
  const titleRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLTextAreaElement>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocusAt && Date.now() - autoFocusAt < 3000) requestAnimationFrame(() => titleRef.current?.focus());
  }, [autoFocusAt]);

  const submit = async () => {
    const t = title.trim();
    if (!t) return;
    setTitle("");
    setDetails("");
    setShowDetails(false);
    titleRef.current?.focus();
    const created = await useTasks.getState().capture(root, t, details, target);
    if (created) {
      setFlash(`${created.id} added`);
      window.setTimeout(() => setFlash(null), 1400);
    }
  };

  return (
    <div className="tk-capture">
      <div className="tk-capture-row">
        <input
          ref={titleRef}
          className="tk-capture-input"
          placeholder="Add a task  (#label !high)"
          value={title}
          spellCheck
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.shiftKey) {
              e.preventDefault();
              setShowDetails(true);
              requestAnimationFrame(() => detailsRef.current?.focus());
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              setTitle("");
              setShowDetails(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
      {showDetails && (
        <textarea
          ref={detailsRef}
          className="tk-capture-details"
          placeholder="Details (Markdown). ⌘↵ to add"
          rows={3}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              titleRef.current?.focus();
            }
          }}
        />
      )}
      <div className="tk-capture-meta">
        <button className="tk-link" onClick={() => {
          setShowDetails((v) => !v);
          if (!showDetails) requestAnimationFrame(() => detailsRef.current?.focus());
        }}>
          <Icon name={showDetails ? "chevronDown" : "chevronRight"} size={12} />Details <span className="tk-kbd">⇧↵</span>
        </button>
        <span className="sb-spacer" />
        {flash ? <span className="tk-flash">{flash}</span> : (
          <span className="tk-target" title="Column for new tasks">
            Add to
            {(["inbox", "todo"] as const).map((c) => (
              <button key={c} className={`tk-target-btn${target === c ? " on" : ""}`} aria-pressed={target === c} onClick={() => setTarget(c)}>
                {c === "inbox" ? "Inbox" : "Todo"}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------- list ----------------

export function TasksView({ root }: { root: string }) {
  const { state, error, loading } = useBoard(root);
  const captureAt = useTasks((s) => s.captureAt);
  const notice = useTasks((s) => s.notice);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [drop, setDrop] = useState<{ column: string; index: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const menu = useContextMenu();
  const project = projectForRoot(root);

  /** ⌘/Ctrl-click toggles, ⇧-click selects a range in the column, a plain click opens. */
  const clickRow = (e: React.MouseEvent, colId: string, id: string) => {
    if (e.metaKey || e.ctrlKey) {
      setPicked((p) => {
        const next = new Set(p);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchor(id);
      return;
    }
    const ids = state?.columns[colId] ?? [];
    if (e.shiftKey && anchor && ids.includes(anchor)) {
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(id);
      setPicked(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
      return;
    }
    setPicked(new Set());
    setAnchor(id);
    open(id);
  };

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      /* storage unavailable */
    }
  }, [collapsed]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => useTasks.getState().setNotice(null), notice.error ? 8000 : 3500);
    return () => window.clearTimeout(t);
  }, [notice]);

  const byId = useMemo(() => new Map((state?.tasks ?? []).map((t) => [t.id, t])), [state]);
  const open = (id: string) => project && openBoard(project.id, id);

  const onDrop = (e: React.DragEvent, column: string, index: number) => {
    const d = readDrag(e);
    setDrop(null);
    if (!d || d.root !== root) return;
    e.preventDefault();
    void useTasks.getState().move(root, d.id, column, adjustedIndex(d, column, index));
  };

  return (
    <div className="tk-view">
      <QuickCapture root={root} autoFocusAt={captureAt} />
      {notice && <div className={`tk-notice${notice.error ? " tk-notice-error" : ""}`} onClick={() => useTasks.getState().setNotice(null)}>{notice.text}</div>}
      <div className="tk-list" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}>
        {error && <div className="sb-empty sb-error">{error}</div>}
        {!state && loading && <div className="sb-empty">Loading…</div>}
        {state && state.tasks.length === 0 && (
          <div className="sb-empty" title="Tasks are Markdown files in .tcon/tasks/">No tasks. Type one above and press ↵.</div>
        )}
        {state && state.tasks.length > 0 && state.board.columns.map((col) => {
          const ids = state.columns[col.id] ?? [];
          const isCollapsed = !!collapsed[col.id];
          return (
            <div key={col.id} className="tk-group">
              <div
                className={`tk-group-header${drop?.column === col.id && (isCollapsed || !ids.length) ? " tk-drop-into" : ""}`}
                onClick={() => setCollapsed((c) => ({ ...c, [col.id]: !c[col.id] }))}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(TASK_DRAG)) return;
                  e.preventDefault();
                  setDrop({ column: col.id, index: isCollapsed ? 0 : ids.length });
                }}
                onDrop={(e) => onDrop(e, col.id, isCollapsed ? 0 : ids.length)}
              >
                <Icon name="chevronRight" size={14} className={`sb-chevron${isCollapsed ? "" : " sb-open"}`} />
                <StatusIcon status={col.id} size={12} />
                <span className="tk-group-title">{col.title}</span>
                <span className="sb-count">{ids.length}</span>
              </div>
              {!isCollapsed && ids.map((id, i) => {
                const t = byId.get(id);
                if (!t) return null;
                return (
                  <TaskRow
                    key={id}
                    root={root}
                    task={t}
                    column={col.id}
                    index={i}
                    dropBefore={drop?.column === col.id && drop.index === i}
                    dropAfter={drop?.column === col.id && drop.index === i + 1 && i === ids.length - 1}
                    onDragOverRow={(index) => setDrop({ column: col.id, index })}
                    onDropRow={(e, index) => onDrop(e, col.id, index)}
                    picked={picked.has(id)}
                    onClickRow={(e) => clickRow(e, col.id, id)}
                    onMenu={(e) => menu.open(e, taskMenuItems(root, t, state, { open: () => open(id) }))}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {state && picked.size > 0 && <BulkBar compact root={root} state={state} ids={[...picked].filter((id) => byId.has(id))} onClear={() => setPicked(new Set())} />}
      {menu.element}
    </div>
  );
}

function TaskRow(props: {
  root: string;
  task: Task;
  column: string;
  index: number;
  dropBefore: boolean;
  dropAfter: boolean;
  onDragOverRow(index: number): void;
  onDropRow(e: React.DragEvent, index: number): void;
  picked: boolean;
  onClickRow(e: React.MouseEvent): void;
  onMenu(e: React.MouseEvent): void;
}) {
  const { root, task, column, index } = props;
  const view = useAgentView(task);
  const [dragging, setDragging] = useState(false);
  const active = view.kind === "working" || view.kind === "blocked" || view.kind === "queued" || view.kind === "waiting" || view.kind === "planning";
  return (
    <div
      className={`tk-row${props.picked ? " tk-picked" : ""}${props.dropBefore ? " tk-drop-before" : ""}${props.dropAfter ? " tk-drop-after" : ""}${dragging ? " tk-dragging" : ""}${task.status === "done" ? " tk-row-done" : ""}`}
      title={`${task.id} · ${task.title}${task.description ? `\n\n${task.description.slice(0, 300)}` : ""}`}
      draggable
      onDragStart={(e) => {
        const payload: DragPayload = { root, id: task.id, column, index };
        e.dataTransfer.setData(TASK_DRAG, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TASK_DRAG)) return;
        e.preventDefault();
        e.stopPropagation();
        props.onDragOverRow(dropIndexFor(e, e.currentTarget, index));
      }}
      onDrop={(e) => {
        e.stopPropagation();
        props.onDropRow(e, dropIndexFor(e, e.currentTarget, index));
      }}
      onClick={props.onClickRow}
      onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
      onContextMenu={props.onMenu}
    >
      <PriorityIcon priority={task.priority} size={12} />
      <span className="tk-row-id">{task.id}</span>
      <span className="tk-row-title">{task.title || "Untitled"}</span>
      <span className="sb-spacer" />
      <AgentChip task={task} compact={!active} />
      <span className="tk-row-actions">
        {!active && task.status !== "done" && (
          <button
            className="sb-icon-btn tk-claude-btn"
            title="Start Claude on this task"
            aria-label="Start Claude on this task"
            onClick={(e) => {
              e.stopPropagation();
              void startAgent(root, task.id);
            }}
          >
            <ClaudeMark size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

/** Compact "Tasks" section for the bottom of the Source Control sidebar. */
export function TasksSection({ root }: { root: string }) {
  const { state } = useBoard(root);
  const KEY = "tcon.tasks.scmOpen";
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== "0";
    } catch {
      return true;
    }
  });
  const menu = useContextMenu();
  const project = projectForRoot(root);
  const openTasks = useMemo(() => {
    if (!state) return [];
    const out: Task[] = [];
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    for (const c of state.board.columns) {
      if (c.id === "done") continue;
      for (const id of state.columns[c.id] ?? []) {
        const t = byId.get(id);
        if (t) out.push(t);
      }
    }
    // Agent activity first, then board order.
    const rank = (t: Task) => (t.agent === "blocked" ? 0 : t.agent === "running" ? 1 : t.agent === "queued" ? 2 : 3);
    return out.map((t, i) => [t, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);
  }, [state]);

  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(KEY, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  };

  return (
    <div className={`sb-section tk-scm-section${open ? " sb-section-open" : ""}`}>
      <div className="sb-section-header" onClick={toggle}>
        <Icon name="chevronRight" size={14} className={`sb-chevron${open ? " sb-open" : ""}`} />
        <span className="sb-section-title">Tasks</span>
        <span className="sb-count">{openTasks.length}</span>
        <span className="sb-spacer" />
        <span className="sb-section-actions" onClick={(e) => e.stopPropagation()}>
          <button className="sb-icon-btn" title="Add task" aria-label="Add task" onClick={quickAddTask}>
            <Icon name="plus" />
          </button>
          {project && (
            <button className="sb-icon-btn" title="Open board" aria-label="Open board" onClick={() => openBoard(project.id)}>
              <Icon name="board" />
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="sb-section-body tk-scm-body">
          {openTasks.length === 0 && <div className="sb-empty">No open tasks.</div>}
          {openTasks.map((t) => (
            <div
              key={t.id}
              className="tk-row tk-row-scm"
              title={`${t.id} · ${t.title}`}
              onClick={() => project && openBoard(project.id, t.id)}
              onContextMenu={(e) => menu.open(e, taskMenuItems(root, t, state, { open: () => project && openBoard(project.id, t.id) }))}
            >
              <StatusIcon status={t.status} size={12} />
              <span className="tk-row-id">{t.id}</span>
              <span className="tk-row-title">{t.title || "Untitled"}</span>
              <span className="sb-spacer" />
              <AgentChip task={t} compact />
            </div>
          ))}
        </div>
      )}
      {menu.element}
    </div>
  );
}
