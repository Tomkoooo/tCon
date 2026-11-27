import { api } from "../api";
import { useWorkspace } from "./workspace";

const gitTimers = new Map<string, number>();

/** Debounced git status refresh for one project. */
export function scheduleGitRefresh(projectId: string, delay = 400) {
  window.clearTimeout(gitTimers.get(projectId));
  gitTimers.set(
    projectId,
    window.setTimeout(async () => {
      const p = useWorkspace.getState().projects[projectId];
      if (!p) return;
      try {
        useWorkspace.getState().setGitStatus(projectId, await api.gitStatus(p.rootPath));
      } catch {
        useWorkspace.getState().setGitStatus(projectId, null);
      }
    }, delay),
  );
}

/** Refresh every project opened on this root (after a git operation). */
export function refreshGitForRoot(root: string, delay = 0) {
  const norm = (s: string) => s.replace(/\/+$/, "");
  for (const p of Object.values(useWorkspace.getState().projects)) if (norm(p.rootPath) === norm(root)) scheduleGitRefresh(p.id, delay);
}
