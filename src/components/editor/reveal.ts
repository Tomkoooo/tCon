// "Open this file at line N": search results ask for a position; the file's editor applies it
// when it's ready (now, or once the file has loaded).
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const pending = new Map<string, { line: number; column: number }>();
const EVENT = "tcon-reveal";

export function requestReveal(path: string, line: number, column = 1) {
  pending.set(path, { line, column });
  window.dispatchEvent(new CustomEvent(EVENT, { detail: path }));
}

/** Apply a pending reveal for `path` to `view` (returns whether there was one). */
export function applyReveal(path: string, view: EditorView | null): boolean {
  const at = pending.get(path);
  if (!at || !view) return false;
  pending.delete(path);
  const doc = view.state.doc;
  const line = doc.line(Math.min(Math.max(1, at.line), doc.lines));
  const pos = Math.min(line.from + Math.max(0, at.column - 1), line.to);
  view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
  return true;
}

export function onRevealRequest(fn: (path: string) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
