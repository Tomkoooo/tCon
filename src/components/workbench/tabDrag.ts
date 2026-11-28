// Pointer-based drag & drop for tab bars.
//
// HTML5 drag & drop doesn't work in the main window: Tauri's native drag-drop handler (kept on so
// files dropped from Finder reach the terminals, see terminal/fileDrop.ts) answers every macOS drag
// callback itself, so WebKit never fires `dragover`/`drop`. Tabs use pointer events instead.
//
// Drop targets are elements with `data-drop-kind="<kind>"`. While the pointer is over one, it gets
// `data-drop="<zone>"` (from `zone()`, by default "before"/"after" by which half is hovered) for CSS.

/** Where an item ends up when dropped before/after the item at `target` (indices in the same list).
 *  `from` is the dragged item's index in that list, or -1 when it comes from another list. The
 *  result is the index to insert at after the item has been removed from the list. */
export function insertIndex(from: number, target: number, after: boolean): number {
  const k = target + (after ? 1 : 0);
  return from >= 0 && from < k ? k - 1 : k;
}

/** "before" or "after" by which half of `el` the pointer is over. */
export function halfOf(el: HTMLElement, ev: { clientX: number }): "before" | "after" {
  const r = el.getBoundingClientRect();
  return ev.clientX < r.left + r.width / 2 ? "before" : "after";
}

export interface TabDragOptions {
  /** Matches `data-drop-kind` on the drop targets. */
  kind: string;
  /** Zone shown on the hovered target; null rejects the target. Default: before/after halves. */
  zone?: (target: HTMLElement, ev: PointerEvent) => string | null;
  /** Called on release over a target. */
  drop: (target: HTMLElement, zone: string) => void;
}

const THRESHOLD = 5;

/** Call from a tab's onPointerDown. The drag starts once the pointer moves a few pixels, so a plain
 *  click still selects the tab. Presses on buttons and inputs inside the tab are ignored. */
export function startTabDrag(e: { button: number; clientX: number; clientY: number; target: EventTarget; currentTarget: EventTarget }, opts: TabDragOptions) {
  if (e.button !== 0) return;
  if ((e.target as Element).closest?.("button, input, textarea, select")) return;
  const source = e.currentTarget as HTMLElement;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let target: HTMLElement | null = null;
  let zone: string | null = null;

  const setTarget = (el: HTMLElement | null, z: string | null) => {
    if (target && (target !== el || z === null)) delete target.dataset.drop;
    target = z === null ? null : el;
    zone = z;
    if (target && zone) target.dataset.drop = zone;
  };

  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < THRESHOLD && Math.abs(ev.clientY - startY) < THRESHOLD) return;
      dragging = true;
      source.classList.add("tab-dragging");
      document.body.classList.add("tab-drag-active");
    }
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const el = (hit?.closest(`[data-drop-kind="${opts.kind}"]`) as HTMLElement | null) ?? null;
    if (!el || el === source) return setTarget(null, null);
    setTarget(el, opts.zone ? opts.zone(el, ev) : halfOf(el, ev));
  };

  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    source.classList.remove("tab-dragging");
    document.body.classList.remove("tab-drag-active");
    const t = target;
    const z = zone;
    setTarget(null, null);
    if (!dragging) return;
    // Swallow the click that follows the release so it doesn't act on the element under it.
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (commit && t && z) opts.drop(t, z);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
