import { useRefresh } from "../../refresh";
import { applyReveal, onRevealRequest } from "./reveal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { themedHighlightStyle } from "../../theming/syntax";
import MarkdownIt from "markdown-it";
import { api } from "../../api";
import type { FsChangedEvent } from "../../types";
import { useWorkspace } from "../../store/workspace";
import { useIsDark } from "../../theme";
import { FileIcon } from "../FileIcon";
import { Icon } from "../icons";
import { editorSavers } from "./editorActions";
import { isMarkdownPath, languageFor } from "./languages";
import "./editor.css";

export interface EditorPaneProps {
  tabId: string;
  path: string;
  root: string;
  diff?: { file: string | null; staged: boolean } | null;
}

export function EditorPane(props: EditorPaneProps) {
  if (props.diff) {
    const d = props.diff;
    return <DiffView key={`${props.root}|${d.file ?? ""}|${d.staged}`} root={props.root} file={d.file} staged={d.staged} />;
  }
  // Keyed by path: a path change fully remounts (and destroys the old EditorView).
  return <FileEditor key={props.path} tabId={props.tabId} path={props.path} root={props.root} />;
}

/** VS Code-style breadcrumb: path relative to the project root. */
function Breadcrumb({ path, root, children }: { path: string; root: string; children?: React.ReactNode }) {
  const rel = path === root ? root.slice(root.lastIndexOf("/") + 1) : path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
  const parts = rel.split("/").filter(Boolean);
  return (
    <div className="ed-header">
      <div className="ed-crumbs" title={path}>
        {parts.map((part, i) => (
          <span key={i} className="ed-crumb">
            {i === parts.length - 1 && <FileIcon name={part} size={14} />}
            <span className={i === parts.length - 1 ? "ed-crumb-last" : undefined}>{part}</span>
            {i < parts.length - 1 && <Icon name="chevronRight" size={12} className="ed-crumb-sep" />}
          </span>
        ))}
      </div>
      <span className="ed-spacer" />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

const trimSlash = (p: string) => (p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p);

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size, 13px)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--editor-font, var(--font-mono))", lineHeight: "var(--editor-line-height, 1.5)" },
});
// All colors come from CSS variables set by the active color theme (see theming/).
const colorTheme = (dark: boolean) =>
  EditorView.theme(
    {
      "&": { backgroundColor: "var(--editor-bg)", color: "var(--syn-default-fg, var(--editor-fg))" },
      ".cm-content": { caretColor: "var(--editor-cursor)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--editor-cursor)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "var(--editor-selection) !important" },
      ".cm-activeLine": { backgroundColor: "var(--editor-line-highlight)" },
      ".cm-selectionMatch": { backgroundColor: "var(--editor-match)" },
      "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--editor-bracket-match)" },
      ".cm-gutters": { backgroundColor: "var(--editor-gutter-bg)", color: "var(--editor-line-number)", border: "none" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--editor-line-number-active)" },
      ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "var(--editor-fold)" },
      ".cm-tooltip, .cm-panels": { backgroundColor: "var(--menu-bg)", color: "var(--menu-fg)", border: "1px solid var(--menu-border)" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--menu-selection-bg)", color: "var(--menu-selection-fg)" },
      ".cm-searchMatch": { backgroundColor: "var(--editor-match)", outline: "1px solid var(--accent)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--editor-selection)" },
    },
    { dark },
  );
const themeFor = (dark: boolean): Extension => [colorTheme(dark), syntaxHighlighting(themedHighlightStyle)];

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** Subscribe to "fs-changed"; handler gets the payload. Safe outside Tauri. */
function useFsChanged(handler: (ev: FsChangedEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<FsChangedEvent>("fs-changed", (ev) => ref.current(ev.payload))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => { /* not running inside Tauri */ });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/* ------------------------------------------------------------- file editor */

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string }
  | { kind: "binary"; size: number }
  | { kind: "tooLarge"; size: number };

type MdMode = "edit" | "split" | "preview";

function FileEditor({ tabId, path, root }: { tabId: string; path: string; root: string }) {
  const isMd = isMarkdownPath(path);
  const dark = useIsDark();
  const setEditorDirty = useWorkspace((s) => s.setEditorDirty);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [diskChanged, setDiskChanged] = useState(false);
  const [mdMode, setMdMode] = useState<MdMode>("split");
  const [previewSrc, setPreviewSrc] = useState("");

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedDocRef = useRef<Text | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const themeComp = useRef(new Compartment());
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const save = useCallback(async (): Promise<boolean> => {
    const view = viewRef.current;
    if (!view) return false;
    const doc = view.state.doc;
    setSaving(true);
    setSaveError(null);
    try {
      await api.fsWriteText(path, doc.toString());
      savedDocRef.current = doc;
      setDirty(!view.state.doc.eq(doc));
      setDiskChanged(false);
      return true;
    } catch (e) {
      setSaveError(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [path]);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Expose save to tab-close prompts; mirror dirty state into the store (tab dot, pinning).
  useEffect(() => {
    const fn = () => saveRef.current();
    editorSavers.set(tabId, fn);
    return () => {
      if (editorSavers.get(tabId) === fn) editorSavers.delete(tabId);
    };
  }, [tabId]);
  useEffect(() => setEditorDirty(tabId, dirty), [tabId, dirty, setEditorDirty]);

  // Create the editor once the file is loaded; destroy it on unmount.
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    api.fsReadText(path).then((fc) => {
      if (cancelled) return;
      if (fc.isBinary) { setLoad({ kind: "binary", size: fc.size }); return; }
      if (fc.tooLarge) { setLoad({ kind: "tooLarge", size: fc.size }); return; }
      const host = hostRef.current;
      if (!host) return;
      const state = EditorState.create({
        doc: fc.content,
        extensions: [
          Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { void saveRef.current(); return true; } }])),
          basicSetup,
          languageFor(path),
          baseTheme,
          themeComp.current.of(themeFor(darkRef.current)),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const saved = savedDocRef.current;
            setDirty(saved ? !u.state.doc.eq(saved) : true);
            if (isMd) {
              clearTimeout(previewTimer.current);
              previewTimer.current = setTimeout(() => setPreviewSrc(u.state.doc.toString()), 150);
            }
          }),
        ],
      });
      savedDocRef.current = state.doc;
      viewRef.current?.destroy();
      viewRef.current = new EditorView({ state, parent: host });
      const created = viewRef.current;
      requestAnimationFrame(() => created.requestMeasure());
      setPreviewSrc(fc.content);
      setDirty(false);
      setLoad({ kind: "ready" });
      requestAnimationFrame(() => applyReveal(path, created));
    }).catch((e: unknown) => {
      if (!cancelled) setLoad({ kind: "error", message: String(e) });
    });
    return () => {
      cancelled = true;
      clearTimeout(previewTimer.current);
      viewRef.current?.destroy();
      viewRef.current = null;
      savedDocRef.current = null;
    };
  }, [path, isMd]);

  // "Open at line" requests for this file (search results) while it's already open.
  useEffect(() => onRevealRequest((p) => p === path && applyReveal(path, viewRef.current)), [path]);

  // Follow the system color scheme.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(themeFor(dark)) });
  }, [dark]);

  const reloadFromDisk = useCallback(async (force: boolean) => {
    const view = viewRef.current;
    if (!view) return;
    let content: string;
    try {
      const fc = await api.fsReadText(path);
      if (fc.isBinary || fc.tooLarge) return;
      content = fc.content;
    } catch {
      return; // deleted or unreadable — keep the buffer
    }
    if (viewRef.current !== view) return;
    const saved = savedDocRef.current;
    if (!force && saved && saved.toString() === content) return; // our own save, or no real change
    if (!force && dirtyRef.current) { setDiskChanged(true); return; }
    if (view.state.doc.toString() !== content) {
      const sel = view.state.selection.main;
      const head = Math.min(sel.head, content.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        selection: { anchor: head },
      });
    }
    savedDocRef.current = view.state.doc;
    setDirty(false);
    setDiskChanged(false);
    if (isMd) setPreviewSrc(content);
  }, [path, isMd]);

  useFsChanged((ev) => {
    // Empty `paths` = the watcher lost events and asks for a full rescan.
    if (ev.paths.length === 0 || ev.paths.some((p) => trimSlash(p) === path)) void reloadFromDisk(false);
  });
  // Manual refresh / window focus: re-read from disk (no-op when unchanged; prompts if dirty).
  useRefresh(root, () => void reloadFromDisk(false));

  const html = useMemo(() => (isMd && mdMode !== "edit" ? md.render(previewSrc) : ""), [isMd, mdMode, previewSrc]);

  const onPreviewClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      e.currentTarget.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) void openUrl(href).catch(() => {});
  };

  const ready = load.kind === "ready";
  const showEditor = !isMd || mdMode !== "preview";
  const showPreview = isMd && mdMode !== "edit";

  return (
    <div className="ed-root">
      <Breadcrumb path={path} root={root}>
        {isMd && ready && (
          <div className="ed-seg" role="group" aria-label="Markdown view mode">
            {(["edit", "split", "preview"] as const).map((m) => (
              <button key={m} className={`ed-seg-btn${mdMode === m ? " ed-seg-active" : ""}`} onClick={() => setMdMode(m)}>
                {m === "edit" ? "Edit" : m === "split" ? "Split" : "Preview"}
              </button>
            ))}
          </div>
        )}
        {saving && <span className="ed-dim">Saving…</span>}
      </Breadcrumb>

      {diskChanged && (
        <div className="ed-banner ed-banner-warn">
          <span>File changed on disk.</span>
          <span className="ed-spacer" />
          <button className="ed-btn" onClick={() => void reloadFromDisk(true)}>Reload</button>
          <button className="ed-btn" onClick={() => setDiskChanged(false)}>Keep mine</button>
        </div>
      )}
      {saveError && (
        <div className="ed-banner ed-banner-error">
          <span>Save failed: {saveError}</span>
          <span className="ed-spacer" />
          <button className="ed-btn" onClick={() => setSaveError(null)}>Dismiss</button>
        </div>
      )}

      <div className="ed-body">
        {load.kind === "loading" && <div className="ed-message">Loading…</div>}
        {load.kind === "error" && <div className="ed-message ed-message-error">{load.message}</div>}
        {load.kind === "binary" && <div className="ed-message">Binary file ({formatSize(load.size)}) — not shown.</div>}
        {load.kind === "tooLarge" && <div className="ed-message">File is too large to open ({formatSize(load.size)}).</div>}
        <div className={`ed-split${ready ? "" : " ed-hidden"}`}>
          <div ref={hostRef} className={`ed-cm${showEditor ? "" : " ed-hidden"}`} />
          {showPreview && (
            <div className="ed-preview" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- diff view */

const MAX_DIFF_LINES = 20000;

export function lineClass(line: string): string {
  if (line.startsWith("@@")) return "ed-diff-hunk";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ")
    || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity ")
    || line.startsWith("rename ") || line.startsWith("old mode") || line.startsWith("new mode")
    || line.startsWith("Binary files")) {
    return "ed-diff-meta";
  }
  if (line.startsWith("+")) return "ed-diff-add";
  if (line.startsWith("-")) return "ed-diff-del";
  return "";
}

function DiffView({ root, file, staged }: { root: string; file: string | null; staged: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gen = useRef(0);

  const load = useCallback(() => {
    const g = ++gen.current;
    api.gitDiff(root, file, staged).then((t) => {
      if (g !== gen.current) return;
      setText(t);
      setError(null);
    }).catch((e: unknown) => {
      if (g === gen.current) setError(String(e));
    });
  }, [root, file, staged]);

  useEffect(() => {
    load();
    return () => {
      gen.current++;
      clearTimeout(timer.current);
    };
  }, [load]);

  useFsChanged((ev) => {
    if (trimSlash(ev.root) !== trimSlash(root)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 300);
  });

  const lines = useMemo(() => {
    if (text === null) return [];
    const all = text.split("\n");
    if (all.length && all[all.length - 1] === "") all.pop();
    return all;
  }, [text]);
  const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;

  return (
    <div className="ed-root">
      <Breadcrumb path={file ? `${root}/${file}` : root} root={root}>
        <span className="ed-dim">{file ? "" : "All files · "}{staged ? "Staged" : "Working tree"}</span>
        <button className="ed-btn" onClick={load}>Reload</button>
      </Breadcrumb>
      <div className="ed-body">
        {error && <div className="ed-message ed-message-error">{error}</div>}
        {!error && text === null && <div className="ed-message">Loading…</div>}
        {!error && text !== null && lines.length === 0 && <div className="ed-message">No differences.</div>}
        {!error && lines.length > 0 && (
          <div className="ed-diff">
            {shown.map((l, i) => (
              <div key={i} className={`ed-diff-line ${lineClass(l)}`}>{l || " "}</div>
            ))}
            {lines.length > MAX_DIFF_LINES && (
              <div className="ed-diff-line ed-diff-meta">… {lines.length - MAX_DIFF_LINES} more lines not shown</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
