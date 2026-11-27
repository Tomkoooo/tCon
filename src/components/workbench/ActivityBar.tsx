import type { Project } from "../../types";
import { useWorkspace } from "../../store/workspace";
import { useContextMenu } from "../ContextMenu";
import { layoutMenuItems } from "./layoutMenu";
import { useTasks } from "../../tasks/store";
import { Icon } from "../icons";

export function ActivityBar({ project }: { project: Project }) {
  const updateProject = useWorkspace((s) => s.updateProject);
  const changes = useWorkspace((s) => (s.gitStatus[project.id]?.isRepo ? s.gitStatus[project.id]!.files.length : 0));
  const menu = useContextMenu();
  const taskRoot = project.rootPath.replace(/\/+$/, "");
  const openTasks = useTasks((s) => s.boards[taskRoot]?.state?.tasks.filter((t) => t.status !== "done").length ?? 0);
  const blockedTasks = useTasks((s) => s.boards[taskRoot]?.state?.tasks.filter((t) => t.agent === "blocked").length ?? 0);

  const toggle = (tab: Project["sidebarTab"]) =>
    updateProject(project.id, project.sidebarOpen && project.sidebarTab === tab ? { sidebarOpen: false } : { sidebarOpen: true, sidebarTab: tab });
  const on = (tab: Project["sidebarTab"]) => project.sidebarOpen && project.sidebarTab === tab;

  return (
    <div className="activitybar">
      <button className={`ab-btn${on("files") ? " on" : ""}`} title="Explorer (⇧⌘E)" aria-label="Explorer" onClick={() => toggle("files")}>
        <Icon name="files" size={22} />
      </button>
      <button className={`ab-btn${on("git") ? " on" : ""}`} title="Source Control (⇧⌘G)" aria-label="Source Control" onClick={() => toggle("git")}>
        <Icon name="branch" size={22} />
        {changes > 0 && <span className="ab-badge">{changes > 99 ? "99+" : changes}</span>}
      </button>
      <button className={`ab-btn${on("tasks") ? " on" : ""}`} title="Tasks" aria-label="Tasks" onClick={() => toggle("tasks")}>
        <Icon name="board" size={22} />
        {openTasks > 0 && (
          <span className={`ab-badge${blockedTasks ? " warn" : ""}`} title={blockedTasks ? `${blockedTasks} agent${blockedTasks > 1 ? "s" : ""} need${blockedTasks > 1 ? "" : "s"} you` : undefined}>
            {openTasks > 99 ? "99+" : openTasks}
          </span>
        )}
      </button>
      <span style={{ flex: 1 }} />
      <button className="ab-btn" title="Layout" aria-label="Layout" onClick={(e) => menu.open(e, layoutMenuItems(project.id))}>
        <Icon name="layout" size={20} />
      </button>
      {menu.element}
    </div>
  );
}
