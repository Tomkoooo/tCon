import type { Project } from "../../types";
import { useWorkspace } from "../../store/workspace";
import { useContextMenu } from "../ContextMenu";
import { layoutMenuItems } from "./layoutMenu";

const FilesIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);
const GitIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" />
    <path d="M6 7v10M18 10c0 4-6 3-11.2 7.5" />
  </svg>
);
const LayoutIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M9 14h12" />
  </svg>
);

export function ActivityBar({ project }: { project: Project }) {
  const updateProject = useWorkspace((s) => s.updateProject);
  const changes = useWorkspace((s) => (s.gitStatus[project.id]?.isRepo ? s.gitStatus[project.id]!.files.length : 0));
  const menu = useContextMenu();

  const toggle = (tab: Project["sidebarTab"]) =>
    updateProject(project.id, project.sidebarOpen && project.sidebarTab === tab ? { sidebarOpen: false } : { sidebarOpen: true, sidebarTab: tab });
  const on = (tab: Project["sidebarTab"]) => project.sidebarOpen && project.sidebarTab === tab;

  return (
    <div className="activitybar">
      <button className={`ab-btn${on("files") ? " on" : ""}`} title="Explorer (⇧⌘E)" onClick={() => toggle("files")}>
        <FilesIcon />
      </button>
      <button className={`ab-btn${on("git") ? " on" : ""}`} title="Source Control (⇧⌘G)" onClick={() => toggle("git")}>
        <GitIcon />
        {changes > 0 && <span className="ab-badge">{changes > 99 ? "99+" : changes}</span>}
      </button>
      <span style={{ flex: 1 }} />
      <button className="ab-btn" title="Layout" onClick={(e) => menu.open(e, layoutMenuItems(project.id))}>
        <LayoutIcon />
      </button>
      {menu.element}
    </div>
  );
}
