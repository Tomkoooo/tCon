import { useWorkspace } from "../../store/workspace";

/** Virtual path of the Help editor tab (one per project). */
export const HELP_PATH = "tcon://help";

/** "Help: Show All Features": open (or reveal) the Help tab in the active project. */
export function openHelp() {
  const ws = useWorkspace.getState();
  const id = ws.activeProjectId;
  if (!id) return;
  ws.setModal(null);
  ws.openEditor(id, HELP_PATH, { kind: "help" });
}
