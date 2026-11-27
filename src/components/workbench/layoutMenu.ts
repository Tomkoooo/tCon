import type { MenuItem } from "../ContextMenu";
import { hasEditors, useWorkspace } from "../../store/workspace";
import type { PanelPosition } from "../../types";

const POSITIONS: [PanelPosition, string][] = [["bottom", "Bottom"], ["top", "Top"], ["left", "Left"], ["right", "Right"]];

/** Workbench layout items shared by the activity bar and the panel header. */
export function layoutMenuItems(projectId: string): MenuItem[] {
  const st = useWorkspace.getState();
  const p = st.projects[projectId];
  if (!p) return [];
  const editors = hasEditors(p);
  return [
    ...POSITIONS.map(([pos, label]): MenuItem => ({
      label: `Terminal Panel: ${label}`, checked: p.panelPosition === pos,
      action: () => st.setPanelPosition(projectId, pos),
    })),
    "sep",
    { label: "Show Terminal Panel", checked: !p.panelHidden || !editors, hint: "⇧⌘J", action: () => st.togglePanel(projectId) },
    { label: "Maximize Terminal Panel", checked: p.panelMaximized, hint: "⇧⌘M", action: () => st.togglePanelMaximized(projectId) },
    { label: "Show Sidebar", checked: p.sidebarOpen, hint: "⌘B", action: () => st.updateProject(projectId, { sidebarOpen: !p.sidebarOpen }) },
  ];
}
