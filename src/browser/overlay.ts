// Keeps each built-in browser page's native webview laid exactly over its editor tab's viewport.
//
// A native child webview always draws above tCon's DOM, so it is shown only when its viewport
// element is really on screen and nothing of ours should cover it:
//  - the viewport must be mounted, laid out (no display:none ancestor: inactive tab, maximized
//    panel, other project) and non-empty;
//  - no overlay (modal, context menu, task drawer, editor drop zone, [data-overlay]) intersects it;
//  - no resize drag (body.resizing) or HTML drag-and-drop (editor tabs) is in progress, because the
//    native view would swallow the pointer events.
// Bounds are re-measured on a ResizeObserver, window resizes and any DOM mutation (rAF-throttled),
// and only sent to the backend when they change. Webviews are created lazily on first show and
// destroyed when their editor tab disappears from the workspace (closed tab or project).
import { useWorkspace } from "../store/workspace";
import { browserApi, type Bounds } from "./api";
import { useBrowser } from "./store";

const OVERLAYS = ".modal-backdrop, .ctx-menu, .tkd-backdrop, .ed-drop-overlay, [data-overlay]";

interface Slot {
  tabId: string;
  el: HTMLElement | null;
  url: string;
  state: "none" | "creating" | "ready" | "failed";
  /** last bounds key sent ("hidden" or "x,y,w,h") */
  sent: string;
  shown: boolean;
}

const slots = new Map<string, Slot>();
let raf = 0;
let dragging = false;
let installed = false;
const resizeObserver = new ResizeObserver(() => schedule());
const mutationObserver = new MutationObserver(() => schedule());

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener("resize", schedule);
  window.addEventListener("dragstart", () => ((dragging = true), schedule()), true);
  const endDrag = () => ((dragging = false), schedule());
  window.addEventListener("dragend", endDrag, true);
  window.addEventListener("drop", endDrag, true);
  mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
}

export function schedule() {
  if (!raf) raf = requestAnimationFrame(sync);
}

/** Called by the tab's viewport on mount. */
export function attach(tabId: string, el: HTMLElement, url: string) {
  install();
  let slot = slots.get(tabId);
  if (!slot) {
    slot = { tabId, el: null, url, state: "none", sent: "", shown: false };
    slots.set(tabId, slot);
  }
  if (slot.el && slot.el !== el) resizeObserver.unobserve(slot.el);
  slot.el = el;
  slot.url = url;
  resizeObserver.observe(el);
  schedule();
}

/** Called on unmount (tab moved to another group, project switched, view re-rendered). */
export function detach(tabId: string, el: HTMLElement | null) {
  const slot = slots.get(tabId);
  if (!slot || (el && slot.el !== el)) return;
  if (slot.el) resizeObserver.unobserve(slot.el);
  slot.el = null;
  schedule();
}

export function isShown(tabId: string) {
  return !!slots.get(tabId)?.shown;
}
export function isReady(tabId: string) {
  return slots.get(tabId)?.state === "ready";
}

/** Retry after a failed create (e.g. the URL was fixed in the address bar). */
export function retry(tabId: string, url: string) {
  const slot = slots.get(tabId);
  if (!slot || slot.state !== "failed") return false;
  slot.state = "none";
  slot.url = url;
  slot.sent = "";
  schedule();
  return true;
}

function destroy(tabId: string) {
  const slot = slots.get(tabId);
  slots.delete(tabId);
  if (slot?.el) resizeObserver.unobserve(slot.el);
  if (slot && slot.state !== "none" && slot.state !== "failed") void browserApi.close(tabId).catch(() => {});
  useBrowser.getState().dropPage(tabId);
}

function intersects(a: DOMRect, b: DOMRect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function measure(slot: Slot, overlays: DOMRect[]): Bounds | null {
  const el = slot.el;
  if (!el || !el.isConnected || dragging || document.body.classList.contains("resizing")) return null;
  if (typeof el.checkVisibility === "function" ? !el.checkVisibility() : el.offsetParent === null) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  if (overlays.some((o) => o.width > 0 && o.height > 0 && intersects(o, r))) return null;
  // clip to the window
  const x = Math.max(0, Math.round(r.left));
  const y = Math.max(0, Math.round(r.top));
  const width = Math.min(window.innerWidth, Math.round(r.right)) - x;
  const height = Math.min(window.innerHeight, Math.round(r.bottom)) - y;
  return width >= 4 && height >= 4 ? { x, y, width, height } : null;
}

function sync() {
  raf = 0;
  if (!slots.size) return;
  const overlays = Array.from(document.querySelectorAll(OVERLAYS), (e) => e.getBoundingClientRect());
  for (const slot of slots.values()) {
    const b = measure(slot, overlays);
    const key = b ? `${b.x},${b.y},${b.width},${b.height}` : "hidden";
    if (slot.state === "none") {
      if (!b) continue; // lazily created on first show
      slot.state = "creating";
      slot.sent = key;
      browserApi
        .create(slot.tabId, slot.url, b, true)
        .then(() => {
          if (!slots.has(slot.tabId)) return void browserApi.close(slot.tabId).catch(() => {}); // closed meanwhile
          slot.state = "ready";
          slot.shown = true;
          schedule(); // catch up with changes made while creating
        })
        .catch((err) => {
          slot.state = "failed";
          useBrowser.getState().patchPage(slot.tabId, { error: String(err), loading: false });
        });
      continue;
    }
    if (slot.state !== "ready" || key === slot.sent) continue;
    slot.sent = key;
    slot.shown = !!b;
    void browserApi.setBounds(slot.tabId, b ?? { x: 0, y: 0, width: 1, height: 1 }, !!b).catch(() => {});
  }
}

// Destroy webviews whose editor tab is gone (closed, or its project was closed).
useWorkspace.subscribe((s, prev) => {
  if (s.projects === prev.projects || !slots.size) return;
  const alive = new Set<string>();
  for (const p of Object.values(s.projects)) for (const g of p.editorGroups) for (const t of g.tabs) if (t.kind === "browser") alive.add(t.id);
  for (const id of [...slots.keys()]) if (!alive.has(id)) destroy(id);
});
