// Dropping files from Finder onto a terminal pastes their paths into it (Claude Code turns a
// pasted image path into an attachment). Tauri's native drag-drop handler receives file drops
// for the whole window, so the HTML drop event never sees them: we map the drop position to
// the terminal pane under it.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useWorkspace } from "../store/workspace";
import { pathsForTerminal } from "./quotePath";
import { terminals } from "./registry";

function paneAt(pos: { x: number; y: number }): HTMLElement | null {
  // Positions are physical pixels.
  const r = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / r, pos.y / r);
  return (el?.closest("[data-pane-id]") as HTMLElement | null) ?? null;
}

let current: HTMLElement | null = null;
function highlight(el: HTMLElement | null) {
  if (current === el) return;
  current?.classList.remove("file-drop");
  current = el;
  current?.classList.add("file-drop");
}

/** Install once (App). Returns a cleanup function. */
export function installFileDrop(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") return highlight(null);
      if (payload.type === "enter" || payload.type === "over") return highlight(paneAt(payload.position));
      if (payload.type !== "drop") return;
      const el = paneAt(payload.position);
      highlight(null);
      const paneId = el?.dataset.paneId;
      const text = pathsForTerminal(payload.paths);
      if (!paneId || !text) return;
      if (!terminals.paste(paneId, text)) return;
      const ws = useWorkspace.getState();
      const project = Object.values(ws.projects).find((p) => p.panes[paneId]);
      if (project) ws.focusPane(project.id, paneId);
      terminals.focus(paneId);
    })
    .then((f) => {
      if (disposed) f();
      else unlisten = f;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
    highlight(null);
  };
}
