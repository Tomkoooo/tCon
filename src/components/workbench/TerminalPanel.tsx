import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import { aggregateStatus, hasEditors, useWorkspace } from "../../store/workspace";
import { paneIds } from "../../store/layout";
import type { LayoutNode, Project, TerminalTab } from "../../types";
import { SplitView } from "../SplitView";
import { TerminalPane } from "../TerminalPane";
import { StatusDot } from "../StatusDot";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { layoutMenuItems } from "./layoutMenu";
import { ClaudeMark, Icon } from "../icons";

const DRAG_TYPE = "text/tcon-term-tab";

export async function closeTerminalTabConfirm(projectId: string, tabId: string) {
  const st = useWorkspace.getState();
  const tab = st.projects[projectId]?.terminalTabs.find((t) => t.id === tabId);
  if (!tab) return;
  const busy = paneIds(tab.layout).some((id) => ["working", "blocked"].includes(st.statuses[id]?.state ?? ""));
  if (busy && !(await ask("This terminal has an active Claude session. Close it anyway?", { title: "Close terminal", kind: "warning" }))) return;
  st.closeTerminalTab(projectId, tabId);
}


export function TerminalPanel({ project }: { project: Project }) {
  const st = useWorkspace.getState();
  const statuses = useWorkspace((s) => s.statuses);
  const resizeSplit = useWorkspace((s) => s.resizeSplit);
  const menu = useContextMenu();
  const editors = hasEditors(project);
  const activeTab = project.terminalTabs.find((t) => t.id === project.activeTerminalTabId) ?? project.terminalTabs[0];
  const multi = activeTab ? paneIds(activeTab.layout).length > 1 : false;

  const paneMenu = useCallback(
    (paneId: string) => (e: React.MouseEvent) => {
      const s = useWorkspace.getState();
      const p = s.projects[project.id];
      const tab = p?.terminalTabs.find((t) => paneIds(t.layout).includes(paneId));
      const items: MenuItem[] = [
        { label: "Split Right", hint: "⌘D", action: () => { s.focusPane(project.id, paneId); s.addTerminal(project.id, { claude: false, split: "row" }); } },
        { label: "Split Down", hint: "⇧⌘D", action: () => { s.focusPane(project.id, paneId); s.addTerminal(project.id, { claude: false, split: "column" }); } },
      ];
      if (tab && paneIds(tab.layout).length > 1) items.push({ label: "Move to New Tab", action: () => s.movePaneToNewTab(project.id, paneId) });
      items.push(
        "sep",
        { label: "New Terminal", hint: "⇧⌘T", action: () => s.addTerminal(project.id, { claude: false }) },
        { label: "New Claude Terminal", hint: "⇧⌘C", action: () => s.addTerminal(project.id, { claude: true }) },
        "sep",
        { label: "Restart", action: () => s.restartPane(paneId) },
        { label: "Kill Terminal", hint: "⌘W", action: () => s.closePane(project.id, paneId) },
      );
      menu.open(e, items);
    },
    [menu, project.id],
  );

  const renderLeaf = (leaf: Extract<LayoutNode, { type: "terminal" }>) => {
    const pane = project.panes[leaf.paneId];
    if (!pane) return null;
    return (
      <TerminalPane
        projectId={project.id}
        pane={pane}
        status={statuses[pane.id]}
        focused={project.focusArea === "terminal" && project.focusedPaneId === pane.id}
        showHeader={multi}
        accent={project.color}
        onContextMenu={paneMenu(pane.id)}
      />
    );
  };

  const split = (dir: "row" | "column") => st.addTerminal(project.id, { claude: false, split: dir });

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-tabs">
          {project.terminalTabs.map((tab, i) => (
            <TermTab key={tab.id} project={project} tab={tab} index={i} active={tab.id === activeTab?.id} />
          ))}
          <button className="icon-btn panel-new" title="New terminal (⇧⌘T)" aria-label="New terminal" onClick={() => st.addTerminal(project.id, { claude: false })}>
            <Icon name="plus" />
          </button>
          <button className="icon-btn panel-new" title="New Claude terminal (⇧⌘C)" aria-label="New Claude terminal" onClick={() => st.addTerminal(project.id, { claude: true })}>
            <ClaudeMark size={13} />
          </button>
        </div>
        <div className="panel-actions">
          {activeTab && (
            <>
              <button className="icon-btn" title="Split right (⌘D)" onClick={() => split("row")}><Icon name="splitRight" /></button>
              <button className="icon-btn" title="Split down (⇧⌘D)" onClick={() => split("column")}><Icon name="splitDown" /></button>
            </>
          )}
          <button className="icon-btn" title="Layout" aria-label="Layout" onClick={(e) => menu.open(e, layoutMenuItems(project.id))}><Icon name="more" /></button>
          {editors && (
            <>
              <button
                className="icon-btn"
                title={project.panelMaximized ? "Restore panel size (⇧⌘M)" : "Maximize panel (⇧⌘M)"}
                onClick={() => st.togglePanelMaximized(project.id)}
              >
                <Icon name={project.panelMaximized ? "chevronDown" : "chevronUp"} />
              </button>
              <button className="icon-btn" title="Hide panel (⇧⌘J)" onClick={() => st.togglePanel(project.id)}><Icon name="close" /></button>
            </>
          )}
        </div>
      </div>
      <div className="panel-body">
        {activeTab ? (
          <SplitView key={activeTab.id} node={activeTab.layout} renderLeaf={renderLeaf} onResize={(id, sizes) => resizeSplit(project.id, id, sizes)} />
        ) : (
          <div className="empty-state">
            <div>No terminals</div>
            <div className="row">
              <button className="btn" onClick={() => st.addTerminal(project.id, { claude: false })}>New terminal</button>
              <button className="btn primary" onClick={() => st.addTerminal(project.id, { claude: true })}>New Claude terminal</button>
            </div>
          </div>
        )}
      </div>
      {menu.element}
    </div>
  );
}

function TermTab({ project, tab, index, active }: { project: Project; tab: TerminalTab; index: number; active: boolean }) {
  const statuses = useWorkspace((s) => s.statuses);
  const menu = useContextMenu();
  const [dragOver, setDragOver] = useState(false);
  const st = useWorkspace.getState();
  const ids = paneIds(tab.layout);
  const panes = ids.map((id) => project.panes[id]).filter(Boolean);
  const first = panes[0];
  const status = aggregateStatus(ids, statuses);
  const firstStatus = first ? statuses[first.id] : undefined;
  const title = (firstStatus?.title || first?.title || "terminal").replace(/^[✳✻✽✶✢·*]\s+/, "");
  const claude = panes.some((p) => p.isClaude);
  const progress = status?.state === "working" && status.progress != null ? status.progress : null;
  const msg = status && (status.state === "blocked" || status.state === "error") ? status.msg || status.kind : null;

  const onContextMenu = (e: React.MouseEvent) =>
    menu.open(e, [
      { label: "Split Right", hint: "⌘D", action: () => { st.setActiveTerminalTab(project.id, tab.id); st.addTerminal(project.id, { claude: false, split: "row" }); } },
      { label: "Split Down", hint: "⇧⌘D", action: () => { st.setActiveTerminalTab(project.id, tab.id); st.addTerminal(project.id, { claude: false, split: "column" }); } },
      "sep",
      { label: "Close", action: () => void closeTerminalTabConfirm(project.id, tab.id) },
      {
        label: "Close Others",
        action: async () => {
          for (const t of project.terminalTabs) if (t.id !== tab.id) await closeTerminalTabConfirm(project.id, t.id);
        },
      },
    ]);

  return (
    <>
    <div
      className={`term-tab${active ? " active" : ""}${dragOver ? " drop" : ""}${status?.state === "blocked" ? " attn" : ""}`}
      style={{ ["--pane-accent" as string]: project.color }}
      title={[panes.map((p) => `${p.title} — ${p.cwd}`).join("\n"), msg].filter(Boolean).join("\n")}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, tab.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id && id !== tab.id) st.moveTerminalTab(project.id, id, index);
      }}
      onMouseDown={(e) => e.button === 0 && st.setActiveTerminalTab(project.id, tab.id)}
      onAuxClick={(e) => e.button === 1 && void closeTerminalTabConfirm(project.id, tab.id)}
      onContextMenu={onContextMenu}
    >
      <StatusDot status={status} />
      {claude && <ClaudeMark size={11} />}
      <span className="term-tab-title">{title}</span>
      {ids.length > 1 && <span className="term-tab-count" title={`${ids.length} split terminals`}>
        <Icon name="splitRight" size={12} />
        {ids.length}
      </span>}
      {progress != null && <span className="pane-progress">{progress}%</span>}
      <button
        className="term-tab-close"
        title="Close (⌘W)"
        aria-label="Close terminal"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => void closeTerminalTabConfirm(project.id, tab.id)}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
    {menu.element}
    </>
  );
}
