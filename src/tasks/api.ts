// Typed wrappers for the task board commands (src-tauri/src/tasks.rs).
import { invoke } from "@tauri-apps/api/core";
import type { Board, BoardSettings, BoardState, BulkOp, Task, TaskPatch } from "./types";

/** The Tauri bridge is missing when the UI runs in a plain browser (vite dev preview). */
export const hasBackend = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const tasksApi = {
  load: (root: string) => invoke<BoardState>("tasks_load", { root }),
  init: (root: string) => invoke<BoardState>("tasks_init", { root }),
  create: (root: string, title: string, description: string, status: string) =>
    invoke<Task>("task_create", { root, title, description, status }),
  update: (root: string, id: string, patch: TaskPatch) => invoke<Task>("task_update", { root, id, patch }),
  move: (root: string, id: string, column: string, index: number) => invoke<BoardState>("task_move", { root, id, column, index }),
  remove: (root: string, id: string) => invoke<void>("task_delete", { root, id }),
  bulk: (root: string, ops: BulkOp[]) => invoke<{ state: BoardState; failed: [string, string][] }>("task_bulk", { root, ops }),
  saveSettings: (root: string, settings: BoardSettings) => invoke<Board>("tasks_save_settings", { root, settings }),
  setQueue: (root: string, queue: string[], batch?: string[]) => invoke<Board>("tasks_set_queue", { root, queue, batch: batch ?? null }),
  installSkill: (configDirs: string[]) => invoke<string[]>("tasks_install_skill", { configDirs }),
  worktreeAdd: (root: string, taskId: string) => invoke<{ path: string; branch: string; base: string }>("task_worktree_add", { root, taskId }),
  worktreeRemove: (root: string, path: string, branch: string, force: boolean) => invoke<string>("task_worktree_remove", { root, path, branch, force }),
  worktreeMerge: (root: string, branch: string) => invoke<string>("task_worktree_merge", { root, branch }),
  worktreePr: (root: string, branch: string, title: string) => invoke<string>("task_worktree_pr", { root, branch, title }),
  refreshSkill: (configDirs: string[]) => invoke<string[]>("tasks_refresh_skill", { configDirs }),
};
