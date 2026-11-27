// Workbench-level task actions used by commands, the sidebar and the board.
import { useWorkspace } from "../store/workspace";
import { useTasks } from "./store";

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Virtual editor path of a project's board tab. */
export const boardPath = (root: string) => `${trim(root)}/.tcon/Task Board`;

function activeProject() {
  const s = useWorkspace.getState();
  return s.activeProjectId ? s.projects[s.activeProjectId] : null;
}

/** Open (or reveal) the board editor tab; optionally open a task's detail drawer. */
export function openBoard(projectId?: string, taskId?: string | null) {
  const ws = useWorkspace.getState();
  const p = projectId ? ws.projects[projectId] : activeProject();
  if (!p) return;
  if (taskId !== undefined) useTasks.getState().setOpenTask(p.rootPath, taskId);
  ws.openEditor(p.id, boardPath(p.rootPath), { kind: "board" });
}

export function showTasksView(projectId?: string) {
  const ws = useWorkspace.getState();
  const p = projectId ? ws.projects[projectId] : activeProject();
  if (p) ws.updateProject(p.id, { sidebarOpen: true, sidebarTab: "tasks" });
}

/** Show the Tasks view and focus its quick-capture box. */
export function quickAddTask() {
  showTasksView();
  useTasks.getState().requestCapture();
}
