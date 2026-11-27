import { useRef } from "react";
import { hasEditors, useWorkspace } from "../store/workspace";
import type { Project } from "../types";
import { Sidebar } from "./sidebar/Sidebar";
import { ActivityBar } from "./workbench/ActivityBar";
import { EditorArea } from "./workbench/EditorArea";
import { TerminalPanel } from "./workbench/TerminalPanel";
import { dragResize } from "./workbench/drag";
import "./workbench/workbench.css";

export function ProjectView({ project }: { project: Project }) {
  const gitStatus = useWorkspace((s) => s.gitStatus[project.id]);
  const openEditor = useWorkspace((s) => s.openEditor);
  const updateProject = useWorkspace((s) => s.updateProject);
  const setPanelSize = useWorkspace((s) => s.setPanelSize);
  const setFocusArea = useWorkspace((s) => s.setFocusArea);
  const wbRef = useRef<HTMLDivElement>(null);

  const editors = hasEditors(project);
  const editorVisible = editors && !project.panelMaximized;
  const panelVisible = !project.panelHidden || !editors;
  const pos = project.panelPosition;
  const vertical = pos === "bottom" || pos === "top";

  const startSidebarDrag = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startW = project.sidebarWidth;
    dragResize(e, "col-resize", (ev) => updateProject(project.id, { sidebarWidth: Math.max(170, Math.min(600, startW + ev.clientX - startX)) }));
  };

  const startPanelDrag = (e: React.PointerEvent) => {
    const el = wbRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragResize(e, vertical ? "row-resize" : "col-resize", (ev) => {
      const size =
        pos === "bottom" ? (r.bottom - ev.clientY) / r.height
        : pos === "top" ? (ev.clientY - r.top) / r.height
        : pos === "right" ? (r.right - ev.clientX) / r.width
        : (ev.clientX - r.left) / r.width;
      setPanelSize(project.id, size * 100);
    });
  };

  return (
    <div className="project-view">
      <ActivityBar project={project} />
      {project.sidebarOpen && (
        <div className="sidebar-host" style={{ width: project.sidebarWidth }}>
          <Sidebar
            root={project.rootPath}
            gitStatus={gitStatus}
            tab={project.sidebarTab}
            onOpenFile={(path, preview) => openEditor(project.id, path, { preview })}
            onOpenDiff={(file, staged) =>
              openEditor(project.id, file ? `${project.rootPath}/${file}` : project.rootPath, { preview: true, diff: { file, staged } })
            }
          />
          <div className="sidebar-resizer" onPointerDown={startSidebarDrag} />
        </div>
      )}
      {/* Both areas stay mounted (CSS order/display) so terminals and editors never remount on layout changes. */}
      <div className={`workbench pos-${pos}`} ref={wbRef}>
        <div className="wb-editor" style={{ display: editorVisible ? undefined : "none" }} onMouseDown={() => setFocusArea(project.id, "editor")}>
          {editors && <EditorArea project={project} />}
        </div>
        {editorVisible && panelVisible && <div className={`wb-resizer ${vertical ? "h" : "v"}`} onPointerDown={startPanelDrag} />}
        <div
          className="wb-panel"
          style={{ display: panelVisible ? undefined : "none", flex: editorVisible ? `0 0 ${project.panelSize}%` : "1 1 0" }}
          onMouseDown={() => setFocusArea(project.id, "terminal")}
        >
          <TerminalPanel project={project} />
        </div>
      </div>
    </div>
  );
}
