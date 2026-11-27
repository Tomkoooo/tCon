// Manual / focus-driven "refresh everything" signal. The fs watcher covers live changes, but a
// refresh re-reads the file tree, git status, the git graph and open editors from disk, so files
// rewritten by other apps (or changes the OS watcher dropped) always show up.
import { useEffect, useRef } from "react";

const EVENT = "tcon:refresh";

/** Refresh one workspace root, or every open workspace when `root` is omitted. */
export function refreshWorkspace(root?: string) {
  window.dispatchEvent(new CustomEvent<{ root?: string }>(EVENT, { detail: { root } }));
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Imperative form of useRefresh for use inside effects; returns an unsubscribe function. */
export function onRefresh(root: string | null, handler: () => void): () => void {
  const on = (e: Event) => {
    const target = (e as CustomEvent<{ root?: string }>).detail?.root;
    if (root === null || !target || trim(target) === trim(root)) handler();
  };
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}

/** Run `handler` when a refresh targets `root` (or all roots). Pass `null` to receive every refresh. */
export function useRefresh(root: string | null, handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onRefresh(root, () => ref.current()), [root]);
}

/** Refresh everything when the window regains focus (throttled). */
export function installFocusRefresh() {
  let last = 0;
  const on = () => {
    const now = Date.now();
    if (now - last < 1500) return;
    last = now;
    refreshWorkspace();
  };
  window.addEventListener("focus", on);
  return () => window.removeEventListener("focus", on);
}
