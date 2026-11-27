// Task boards, one per workspace root. The files under <root>/.tcon/ are the source of truth:
// every change goes through the Rust backend (fresh read-modify-write + atomic rename) and the
// board is re-read whenever the fs watcher reports a change under .tcon/, so edits Claude makes
// to the task files show up live.
import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { hasBackend, tasksApi } from "./api";
import { DEFAULT_SETTINGS, type BoardSettings, type BoardState, type Task, type TaskPatch } from "./types";
import type { FsChangedEvent } from "../types";
import { onRefresh } from "../refresh";
import { parseQuickInput } from "../quick/parse";

export interface BoardEntry {
  state: BoardState | null;
  error: string | null;
  loading: boolean;
}

export interface AgentPrompt {
  key: string;
  root: string;
  taskId: string;
  title: string;
}

interface TasksState {
  boards: Record<string, BoardEntry>;
  /** "Start Claude on this new Todo task?" prompts */
  prompts: AgentPrompt[];
  /** task to show in a root's board drawer */
  openTask: Record<string, string | null>;
  /** last "quick add" request (focuses the capture box when the Tasks view shows) */
  captureAt: number;
  /** transient message for the tasks UI (errors, "skill installed") */
  notice: { text: string; error?: boolean; at: number } | null;

  load(root: string): Promise<void>;
  ensure(root: string): void;
  create(root: string, title: string, description?: string, status?: string): Promise<Task | null>;
  /** Create from typed text: `#label` and `!priority` tokens in the title are applied, not kept. */
  capture(root: string, text: string, description?: string, status?: string): Promise<Task | null>;
  update(root: string, id: string, patch: TaskPatch): Promise<Task | null>;
  move(root: string, id: string, column: string, index: number): Promise<void>;
  remove(root: string, id: string): Promise<void>;
  saveSettings(root: string, patch: Partial<BoardSettings>): Promise<void>;
  /** Replace the run queue (and optionally the current batch). */
  setQueue(root: string, queue: string[], batch?: string[]): Promise<void>;
  setOpenTask(root: string, id: string | null): void;
  requestCapture(): void;
  pushPrompt(p: Omit<AgentPrompt, "key">): void;
  dismissPrompt(key: string): void;
  setNotice(text: string | null, error?: boolean): void;
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Listeners notified with (root, previous, next) after every successful load. */
type LoadListener = (root: string, prev: BoardState | null, next: BoardState) => void;
const loadListeners = new Set<LoadListener>();
export function onBoardLoaded(fn: LoadListener): () => void {
  loadListeners.add(fn);
  return () => loadListeners.delete(fn);
}

/** Last board state read from disk per root (for change detection). */
const lastDisk = new Map<string, BoardState>();
const EMPTY_ENTRY: BoardEntry = { state: null, error: null, loading: false };

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

export const useTasks = create<TasksState>((set, get) => {
  const setEntry = (root: string, patch: Partial<BoardEntry>) =>
    set((s) => ({ boards: { ...s.boards, [root]: { ...(s.boards[root] ?? EMPTY_ENTRY), ...patch } } }));

  const applyState = (root: string, next: BoardState) => {
    // Diff against the last state read from disk, not the optimistic local one.
    const prev = lastDisk.get(root) ?? null;
    lastDisk.set(root, next);
    setEntry(root, { state: next, error: null, loading: false });
    loadListeners.forEach((fn) => fn(root, prev, next));
  };

  /** Optimistically replace one task in the local state. */
  const patchLocal = (root: string, task: Task) => {
    const st = get().boards[root]?.state;
    if (!st) return;
    const exists = st.tasks.some((t) => t.id === task.id);
    const tasks = exists ? st.tasks.map((t) => (t.id === task.id ? task : t)) : [...st.tasks, task];
    let columns = st.columns;
    if (!exists) {
      const col = st.board.columns.some((c) => c.id === task.status) ? task.status : st.board.columns[0]?.id;
      if (col) columns = { ...columns, [col]: [...(columns[col] ?? []), task.id] };
    }
    setEntry(root, { state: { ...st, tasks, columns, initialized: true } });
  };

  const fail = (e: unknown) => {
    get().setNotice(errText(e), true);
    return null;
  };

  return {
    boards: {},
    prompts: [],
    openTask: {},
    captureAt: 0,
    notice: null,

    async load(root) {
      root = trim(root);
      if (!hasBackend()) {
        setEntry(root, { error: "Task board needs the tCon app (no backend in a plain browser).", loading: false });
        return;
      }
      // Coalesce: one load in flight per root, plus at most one queued re-read.
      if (inflight.has(root)) {
        again.add(root);
        return inflight.get(root);
      }
      const run = (async () => {
        if (!get().boards[root]?.state) setEntry(root, { loading: true });
        try {
          applyState(root, await tasksApi.load(root));
        } catch (e) {
          setEntry(root, { error: errText(e), loading: false });
        }
      })();
      inflight.set(root, run);
      try {
        await run;
      } finally {
        inflight.delete(root);
        if (again.delete(root)) void get().load(root);
      }
    },

    ensure(root) {
      root = trim(root);
      const e = get().boards[root];
      if (!e || (!e.state && !e.loading && !e.error)) void get().load(root);
    },

    async create(root, title, description = "", status = "inbox") {
      root = trim(root);
      if (!title.trim()) return null;
      try {
        const t = await tasksApi.create(root, title, description, status);
        patchLocal(root, t);
        void get().load(root);
        return t;
      } catch (e) {
        return fail(e);
      }
    },

    async capture(root, text, description = "", status = "inbox") {
      const p = parseQuickInput(text);
      if (!p.title) return null;
      const desc = [p.description, description.trim()].filter(Boolean).join("\n\n");
      const t = await get().create(root, p.title, desc, status);
      if (!t || (!p.priority && !p.labels.length)) return t;
      return get().update(root, t.id, { ...(p.priority ? { priority: p.priority } : {}), ...(p.labels.length ? { labels: p.labels } : {}) });
    },

    async update(root, id, patch) {
      root = trim(root);
      const cur = get().boards[root]?.state?.tasks.find((t) => t.id === id);
      if (cur) {
        const { log: _log, ...fields } = patch;
        patchLocal(root, { ...cur, ...fields } as Task);
      }
      try {
        const t = await tasksApi.update(root, id, patch);
        patchLocal(root, t);
        if (patch.status !== undefined) void get().load(root);
        return t;
      } catch (e) {
        void get().load(root);
        return fail(e);
      }
    },

    async move(root, id, column, index) {
      root = trim(root);
      const st = get().boards[root]?.state;
      if (st) {
        // Optimistic: reorder locally so drag & drop feels instant.
        const columns: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(st.columns)) columns[k] = v.filter((x) => x !== id);
        const dest = [...(columns[column] ?? [])];
        dest.splice(Math.max(0, Math.min(index, dest.length)), 0, id);
        columns[column] = dest;
        const tasks = st.tasks.map((t) => (t.id === id ? { ...t, status: column } : t));
        setEntry(root, { state: { ...st, columns, tasks } });
      }
      try {
        applyState(root, await tasksApi.move(root, id, column, index));
      } catch (e) {
        fail(e);
        void get().load(root);
      }
    },

    async remove(root, id) {
      root = trim(root);
      const st = get().boards[root]?.state;
      if (st) {
        const columns: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(st.columns)) columns[k] = v.filter((x) => x !== id);
        setEntry(root, { state: { ...st, columns, tasks: st.tasks.filter((t) => t.id !== id) } });
      }
      if (get().openTask[root] === id) get().setOpenTask(root, null);
      try {
        await tasksApi.remove(root, id);
      } catch (e) {
        fail(e);
      }
      void get().load(root);
    },

    async saveSettings(root, patch) {
      root = trim(root);
      const st = get().boards[root]?.state;
      const settings: BoardSettings = { ...DEFAULT_SETTINGS, ...st?.board.settings, ...patch };
      if (st) setEntry(root, { state: { ...st, board: { ...st.board, settings } } });
      try {
        await tasksApi.saveSettings(root, settings);
      } catch (e) {
        fail(e);
      }
      void get().load(root);
    },

    async setQueue(root, queue, batch) {
      root = trim(root);
      const st = get().boards[root]?.state;
      if (st) setEntry(root, { state: { ...st, board: { ...st.board, runQueue: queue, batch: batch ?? st.board.batch } } });
      try {
        const board = await tasksApi.setQueue(root, queue, batch);
        const cur = get().boards[root]?.state;
        if (cur) setEntry(root, { state: { ...cur, board: { ...cur.board, runQueue: board.runQueue, batch: board.batch } } });
      } catch (e) {
        fail(e);
        void get().load(root);
      }
    },

    setOpenTask(root, id) {
      set((s) => ({ openTask: { ...s.openTask, [trim(root)]: id } }));
    },

    requestCapture() {
      set({ captureAt: Date.now() });
    },

    pushPrompt(p) {
      const key = `${p.root}::${p.taskId}`;
      if (get().prompts.some((x) => x.key === key)) return;
      set((s) => ({ prompts: [...s.prompts, { ...p, key }].slice(-4) }));
    },

    dismissPrompt(key) {
      set((s) => ({ prompts: s.prompts.filter((p) => p.key !== key) }));
    },

    setNotice(text, error) {
      set({ notice: text ? { text, error, at: Date.now() } : null });
    },
  };
});

/** Board state for a root (loads it on first use). */
export function useBoard(root: string): BoardEntry {
  const key = trim(root);
  const entry = useTasks((s) => s.boards[key]);
  useEffect(() => useTasks.getState().ensure(key), [key]);
  return entry ?? { state: null, error: null, loading: true };
}

export function taskById(root: string, id: string): Task | undefined {
  return useTasks.getState().boards[trim(root)]?.state?.tasks.find((t) => t.id === id);
}

// ---------------- live updates ----------------

const timers = new Map<string, number>();
function scheduleLoad(root: string, delay = 120) {
  window.clearTimeout(timers.get(root));
  timers.set(root, window.setTimeout(() => {
    timers.delete(root);
    void useTasks.getState().load(root);
  }, delay));
}

let installed = false;
/** Re-read boards when files under .tcon/ change or on a manual / focus refresh. */
export function installTaskWatchers(): () => void {
  if (installed || !hasBackend()) return () => {};
  installed = true;
  const un = listen<FsChangedEvent>("fs-changed", ({ payload }) => {
    const root = trim(payload.root);
    if (!useTasks.getState().boards[root]) return;
    const prefix = `${root}/.tcon/`;
    if (!payload.paths.length || payload.paths.some((p) => p.startsWith(prefix) || p === `${root}/.tcon`)) scheduleLoad(root);
  });
  const offRefresh = onRefresh(null, () => {
    for (const root of Object.keys(useTasks.getState().boards)) scheduleLoad(root, 0);
  });
  return () => {
    installed = false;
    void un.then((f) => f());
    offRefresh();
  };
}
