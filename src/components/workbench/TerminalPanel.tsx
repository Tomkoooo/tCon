import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { aggregateStatus, hasEditors, useWorkspace } from "../../store/workspace";
import { paneIds } from "../../store/layout";
import type { LayoutNode, PaneStatus, Project, TerminalTab } from "../../types";
import { SplitView } from "../SplitView";
import { TerminalPane } from "../TerminalPane";
import { StatusDot } from "../StatusDot";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { layoutMenuItems } from "./layoutMenu";
import { ClaudeMark, Icon } from "../icons";
import { insertIndex, startTabDrag } from "./tabDrag";

const DRAG_KIND = "term-tab";

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
          {project.terminalTabs.filter((t) => t.group !== "agents").map((tab) => (
            <TermTab key={tab.id} project={project} tab={tab} active={tab.id === activeTab?.id} />
          ))}
          <AgentGroup project={project} activeTab={activeTab} />
          {activeTab?.group === "agents" && <TermTab key={activeTab.id} project={project} tab={activeTab} active />}
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

function tabTitle(project: Project, tab: TerminalTab, statuses: Record<string, PaneStatus>): string {
  const first = project.panes[paneIds(tab.layout)[0]];
  const st = first ? statuses[first.id] : undefined;
  return (st?.title || first?.title || "terminal").replace(/^[✳✻✽✶✢·*]\s+/, "");
}

const STATE_LABEL: Partial<Record<PaneStatus["state"], string>> = {
  working: "Working", blocked: "Needs you", done: "Done", error: "Error", exited: "Exited", idle: "Idle",
};

/** Task agents' terminals, collapsed into one tab so they don't crowd your own terminals. */
function AgentGroup({ project, activeTab }: { project: Project; activeTab: TerminalTab | undefined }) {
  const statuses = useWorkspace((s) => s.statuses);
  const menu = useContextMenu();
  const tabs = project.terminalTabs.filter((t) => t.group === "agents");
  if (!tabs.length) return null;
  const st = useWorkspace.getState();
  const ids = tabs.flatMap((t) => paneIds(t.layout));
  const status = aggregateStatus(ids, statuses);
  const finished = tabs.filter((t) => paneIds(t.layout).every((id) => {
    const pane = project.panes[id];
    return pane?.exited || ["done", "exited", "error"].includes(statuses[id]?.state ?? "");
  }));
  const open = (e: React.MouseEvent) =>
    menu.open(e, [
      { header: "Agent terminals" },
      ...tabs.map((t) => {
        const s = aggregateStatus(paneIds(t.layout), statuses);
        return { label: tabTitle(project, t, statuses), hint: s ? STATE_LABEL[s.state] : undefined, checked: t.id === activeTab?.id, action: () => st.setActiveTerminalTab(project.id, t.id) };
      }),
      "sep",
      {
        label: `Close Finished (${finished.length})`,
        title: "Close agent terminals whose Claude isn't working",
        disabled: !finished.length,
        action: () => finished.forEach((t) => st.closeTerminalTab(project.id, t.id)),
      },
      { label: "Close All Agent Terminals", action: async () => { for (const t of tabs) await closeTerminalTabConfirm(project.id, t.id); } },
    ], { anchor: "below-start", minWidth: 240 });

  return (
    <>
      <button
        className={`term-tab term-group${activeTab?.group === "agents" ? " open" : ""}${status?.state === "blocked" ? " attn" : ""}`}
        title="Terminals of task agents working in the background"
        aria-label={`Agent terminals (${tabs.length})`}
        onClick={open}
        onContextMenu={open}
      >
        <StatusDot status={status} />
        <ClaudeMark size={11} />
        <span className="term-tab-title">Agents</span>
        <span className="term-tab-count">{tabs.length}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {menu.element}
    </>
  );
}

function TermTab({ project, tab, active }: { project: Project; tab: TerminalTab; active: boolean }) {
  const statuses = useWorkspace((s) => s.statuses);
  const menu = useContextMenu();
  const st = useWorkspace.getState();
  const ids = paneIds(tab.layout);
  const panes = ids.map((id) => project.panes[id]).filter(Boolean);
  const status = aggregateStatus(ids, statuses);
  const title = tabTitle(project, tab, statuses);
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
      className={`term-tab${active ? " active" : ""}${status?.state === "blocked" ? " attn" : ""}`}
      title={[panes.map((p) => `${p.title} — ${p.cwd}`).join("\n"), msg].filter(Boolean).join("\n")}
      data-drop-kind={DRAG_KIND}
      data-id={tab.id}
      onPointerDown={(e) =>
        startTabDrag(e, {
          kind: DRAG_KIND,
          drop: (target, zone) => {
            const tabs = useWorkspace.getState().projects[project.id]?.terminalTabs ?? [];
            const to = tabs.findIndex((t) => t.id === target.dataset.id);
            const from = tabs.findIndex((t) => t.id === tab.id);
            if (to >= 0) st.moveTerminalTab(project.id, tab.id, insertIndex(from, to, zone === "after"));
          },
        })
      }
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
