import { useCallback, useState } from "react";
import { editorDiffs, useWorkspace } from "../store/workspace";
import type { LayoutNode, Project } from "../types";
import { SplitView } from "./SplitView";
import { TerminalPane } from "./TerminalPane";
import { Sidebar } from "./sidebar/Sidebar";
import { EditorPane } from "./editor/EditorPane";
import { useContextMenu } from "./ContextMenu";

export function ProjectView({ project }: { project: Project }) {
  const statuses = useWorkspace((s) => s.statuses);
  const gitStatus = useWorkspace((s) => s.gitStatus[project.id]);
  const resizeSplit = useWorkspace((s) => s.resizeSplit);
  const openEditor = useWorkspace((s) => s.openEditor);
  const closeLeaf = useWorkspace((s) => s.closeLeaf);
  const focusPane = useWorkspace((s) => s.focusPane);
  const updateProject = useWorkspace((s) => s.updateProject);
  const [sidebarW, setSidebarW] = useState(270);
  const menu = useContextMenu();

  const paneMenu = useCallback(
    (paneId: string) => (e: React.MouseEvent) => {
      const st = useWorkspace.getState();
      menu.open(e, [
        { label: "Split Right", hint: "⌘D", action: () => st.addPane(project.id, { claude: false, direction: "row" }) },
        { label: "Split Down", hint: "⇧⌘D", action: () => st.addPane(project.id, { claude: false, direction: "column" }) },
        { label: "New Claude Pane", hint: "⇧⌘C", action: () => st.addPane(project.id, { claude: true, direction: "row" }) },
        "sep",
        { label: "Restart", action: () => st.restartPane(paneId) },
        { label: "Close Pane", hint: "⌘W", action: () => st.closePane(project.id, paneId) },
      ]);
    },
    [menu, project.id],
  );

  const renderLeaf = (leaf: Exclude<LayoutNode, { type: "split" }>) => {
    if (leaf.type === "terminal") {
      const pane = project.panes[leaf.paneId];
      if (!pane) return null;
      return (
        <TerminalPane
          projectId={project.id}
          pane={pane}
          status={statuses[pane.id]}
          focused={project.focusedPaneId === pane.id}
          accent={project.color}
          onContextMenu={paneMenu(pane.id)}
        />
      );
    }
    const diff = editorDiffs.get(leaf.id);
    return (
      <div
        className={`pane${project.focusedPaneId === leaf.id ? " focused" : ""}`}
        style={{ ["--pane-accent" as string]: project.color }}
        onMouseDown={() => focusPane(project.id, leaf.id)}
      >
        <EditorPane
          key={leaf.id}
          path={leaf.path}
          onClose={() => closeLeaf(project.id, leaf.id)}
          diff={diff ? { root: project.rootPath, ...diff } : undefined}
        />
      </div>
    );
  };

  const startSidebarDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const move = (ev: PointerEvent) => setSidebarW(Math.max(180, Math.min(600, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="project-view">
      {project.sidebarOpen && (
        <div className="sidebar-host" style={{ ["--sidebar-w" as string]: `${sidebarW}px` }}>
          <Sidebar
            root={project.rootPath}
            gitStatus={gitStatus}
            tab={project.sidebarTab}
            onTabChange={(tab) => updateProject(project.id, { sidebarTab: tab })}
            onOpenFile={(path) => openEditor(project.id, path)}
            onOpenDiff={(file, staged) =>
              openEditor(project.id, file ? `${project.rootPath}/${file}` : project.rootPath, { file, staged })
            }
          />
          <div className="sidebar-resizer" onPointerDown={startSidebarDrag} />
        </div>
      )}
      <div className="layout-host">
        {project.layout ? (
          <SplitView node={project.layout} renderLeaf={renderLeaf} onResize={(id, sizes) => resizeSplit(project.id, id, sizes)} />
        ) : (
          <div className="empty-state">No panes</div>
        )}
      </div>
      {menu.element}
    </div>
  );
}
