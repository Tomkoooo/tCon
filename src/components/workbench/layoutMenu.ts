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
  const check = (on: boolean, label: string) => `${on ? "✓" : " "} ${label}`;
  return [
    ...POSITIONS.map(([pos, label]): MenuItem => ({
      label: check(p.panelPosition === pos, `Terminal Panel: ${label}`),
      action: () => st.setPanelPosition(projectId, pos),
    })),
    "sep",
    { label: check(!p.panelHidden || !editors, "Show Terminal Panel"), hint: "⇧⌘J", action: () => st.togglePanel(projectId) },
    { label: check(p.panelMaximized, "Maximize Terminal Panel"), hint: "⇧⌘M", action: () => st.togglePanelMaximized(projectId) },
    { label: check(p.sidebarOpen, "Show Sidebar"), hint: "⌘B", action: () => st.updateProject(projectId, { sidebarOpen: !p.sidebarOpen }) },
  ];
}
