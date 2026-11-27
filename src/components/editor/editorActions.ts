import { message } from "@tauri-apps/plugin-dialog";
import { findEditorTab, useWorkspace } from "../../store/workspace";

/** Save handlers of mounted file editors, by editor tab id. */
export const editorSavers = new Map<string, () => Promise<boolean>>();

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Ask what to do with unsaved changes. Returns false if the user cancelled. */
async function resolveDirty(tabId: string, path: string): Promise<boolean> {
  if (!useWorkspace.getState().dirtyEditors[tabId]) return true;
  let answer: string;
  try {
    answer = await message(`Do you want to save the changes you made to ${baseName(path)}?\n\nYour changes will be lost if you don't save them.`, {
      title: "Unsaved changes",
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
  } catch {
    answer = window.confirm(`Discard unsaved changes in ${baseName(path)}?`) ? "No" : "Cancel";
  }
  if (answer === "Yes" || answer === "Save") return (await editorSavers.get(tabId)?.()) ?? false;
  return answer === "No" || answer === "Don't Save";
}

/** Close editor tabs, asking about unsaved changes first. Stops at the first cancel. */
export async function closeEditors(projectId: string, tabIds: string[]): Promise<boolean> {
  for (const id of tabIds) {
    const p = useWorkspace.getState().projects[projectId];
    const found = p && findEditorTab(p, id);
    if (!found) continue;
    if (!(await resolveDirty(id, found[1].path))) return false;
    useWorkspace.getState().closeEditorTab(projectId, id);
  }
  return true;
}

/** Before closing a whole project: resolve every dirty editor in it. */
export async function confirmProjectEditors(projectId: string): Promise<boolean> {
  const p = useWorkspace.getState().projects[projectId];
  if (!p) return true;
  for (const g of p.editorGroups) for (const t of g.tabs) if (!(await resolveDirty(t.id, t.path))) return false;
  return true;
}
