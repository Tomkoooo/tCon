// Review actions for tasks an agent did in its own git worktree (isolation: worktree).
import { openUrl } from "@tauri-apps/plugin-opener";
import { tasksApi } from "./api";
import { useTasks } from "./store";
import type { Task } from "./types";

const note = (text: string, error = false) => useTasks.getState().setNotice(text, error);

export async function mergeTaskBranch(root: string, task: Task) {
  try {
    await tasksApi.worktreeMerge(root, task.branch);
    await useTasks.getState().update(root, task.id, { log: `Merged ${task.branch} into the main checkout` });
    note(`Merged ${task.branch}. Remove the worktree when you're done with it.`);
  } catch (e) {
    note(String(e), true);
  }
}

export async function openTaskPr(root: string, task: Task) {
  try {
    const url = await tasksApi.worktreePr(root, task.branch, `${task.id}: ${task.title}`);
    await useTasks.getState().update(root, task.id, { log: url ? `Pull request: ${url}` : "Pull request opened" });
    if (/^https:\/\//.test(url)) void openUrl(url);
  } catch (e) {
    note(String(e), true);
  }
}

export async function removeTaskWorktree(root: string, task: Task, force = false) {
  try {
    const msg = await tasksApi.worktreeRemove(root, task.worktree, task.branch, force);
    await useTasks.getState().update(root, task.id, { worktree: "", log: "Worktree removed" });
    note(msg);
  } catch (e) {
    note(`${e}${force ? "" : " Use Remove anyway to discard it."}`, true);
    return false;
  }
  return true;
}
