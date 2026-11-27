// Typed wrappers for the task board commands (src-tauri/src/tasks.rs).
import { invoke } from "@tauri-apps/api/core";
import type { Board, BoardSettings, BoardState, Task, TaskPatch } from "./types";

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
  saveSettings: (root: string, settings: BoardSettings) => invoke<Board>("tasks_save_settings", { root, settings }),
  installSkill: (configDirs: string[]) => invoke<string[]>("tasks_install_skill", { configDirs }),
};
