import { onRefresh, refreshWorkspace } from "../../refresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../api";
import type { FsChangedEvent, FsEntry, GitStatus } from "../../types";
import { buildDecorIndex, lookupDecor, parentDir, trimSlash } from "./gitDecor";
import { FileIcon } from "../FileIcon";
import "./sidebar.css";

export interface FileTreeProps {
  root: string;
  gitStatus?: GitStatus | null;
  /** preview = single click (VS Code preview tab); false = pinned open */
  onOpenFile(path: string, preview: boolean): void;
}

interface Row {
  entry: FsEntry;
  depth: number;
}

const ROW_INDENT = 10;

export function FileTree({ root: rawRoot, gitStatus, onOpenFile }: FileTreeProps) {
  const root = trimSlash(rawRoot);
  const [showHidden, setShowHidden] = useState(false);
  // Expanded directories, remembered per root for the lifetime of the component.
  const [expandedByRoot, setExpandedByRoot] = useState<Record<string, string[]>>({});
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(() => new Map());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const expanded = useMemo(() => new Set(expandedByRoot[root] ?? []), [expandedByRoot, root]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  // Track in-flight loads to avoid duplicate requests.
  const loading = useRef(new Set<string>());
  // Bumped whenever the cache is reset so stale in-flight results are dropped.
  const generation = useRef(0);

  const loadDir = useCallback(async (dir: string) => {
    if (loading.current.has(dir)) return;
    loading.current.add(dir);
    const gen = generation.current;
    try {
      const entries = await api.fsListDir(dir, showHiddenRef.current);
      if (gen !== generation.current) return;
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      setChildren((prev) => {
        const next = new Map(prev);
        next.set(dir, entries);
        return next;
      });
      setErrors((prev) => {
        if (!prev.has(dir)) return prev;
        const next = new Map(prev);
        next.delete(dir);
        return next;
      });
    } catch (e) {
      if (gen !== generation.current) return;
      setErrors((prev) => new Map(prev).set(dir, String(e)));
    } finally {
      if (gen === generation.current) loading.current.delete(dir);
    }
  }, []);

  // Reset cache when hidden-file visibility changes; (re)load root.
  const resetCache = useCallback(() => {
    generation.current++;
    loading.current = new Set();
    setChildren(new Map());
    setErrors(new Map());
  }, []);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    resetCache();
  }, [showHidden, resetCache]);

  // Load root + any expanded dirs that aren't cached yet.
  useEffect(() => {
    if (!children.has(root) && !errors.has(root)) void loadDir(root);
    for (const d of expanded) {
      if (!children.has(d) && !errors.has(d)) void loadDir(d);
    }
  }, [root, expanded, children, errors, loadDir]);

  // Refresh on file system changes.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = new Set<string>();
    let refreshAll = false;

    const flush = () => {
      timer = undefined;
      const dirs = new Set<string>();
      const exp = expandedRef.current;
      const loaded = (d: string) => d === root || exp.has(d);
      if (refreshAll) {
        dirs.add(root);
        exp.forEach((d) => dirs.add(d));
      } else {
        for (const p of pending) {
          const t = trimSlash(p);
          const parent = parentDir(t);
          if (loaded(parent)) dirs.add(parent);
          // A directory itself changed (e.g. renamed/recreated) — refresh it if expanded.
          if (exp.has(t)) dirs.add(t);
        }
      }
      pending = new Set();
      refreshAll = false;
      dirs.forEach((d) => void loadDir(d));
    };

    const offRefresh = onRefresh(root, () => {
      refreshAll = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 0);
    });

    listen<FsChangedEvent>("fs-changed", (ev) => {
      if (trimSlash(ev.payload.root) !== root) return;
      if (ev.payload.paths.length === 0) refreshAll = true;
      for (const p of ev.payload.paths) pending.add(p);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 120);
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    }).catch(() => { /* not running inside Tauri */ });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
      offRefresh();
    };
  }, [root, loadDir]);

  const decor = useMemo(() => buildDecorIndex(gitStatus), [gitStatus]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const list = children.get(dir);
      if (!list) return;
      for (const entry of list) {
        out.push({ entry, depth });
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [children, expanded, root]);

  const setExpanded = useCallback((path: string, open: boolean) => {
    setExpandedByRoot((prev) => {
      const cur = new Set(prev[root] ?? []);
      if (open) cur.add(path);
      else cur.delete(path);
      return { ...prev, [root]: [...cur] };
    });
  }, [root]);

  const activate = useCallback((entry: FsEntry, preview = true) => {
    setSelected(entry.path);
    if (entry.isDir) setExpanded(entry.path, !expanded.has(entry.path));
    else onOpenFile(entry.path, preview);
  }, [expanded, onOpenFile, setExpanded]);

  const collapseAll = () => setExpandedByRoot((prev) => ({ ...prev, [root]: [] }));
  const refresh = () => refreshWorkspace(root);

  // Keep the selected row visible.
  useEffect(() => {
    if (!selected || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const idx = selected ? rows.findIndex((r) => r.entry.path === selected) : -1;
    const cur = idx >= 0 ? rows[idx] : undefined;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected(rows[Math.min(rows.length - 1, idx + 1)].entry.path);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected(rows[Math.max(0, idx - 1)].entry.path);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (cur?.entry.isDir) {
          if (!expanded.has(cur.entry.path)) setExpanded(cur.entry.path, true);
          else if (rows[idx + 1]?.depth === cur.depth + 1) setSelected(rows[idx + 1].entry.path);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (!cur) break;
        if (cur.entry.isDir && expanded.has(cur.entry.path)) setExpanded(cur.entry.path, false);
        else {
          const parent = parentDir(cur.entry.path);
          if (parent !== root) setSelected(parent);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (cur) activate(cur.entry, false);
        break;
    }
  };

  const rootError = errors.get(root);

  return (
    <div className="sb-tree">
      <div className="sb-toolbar">
        <span className="sb-toolbar-title" title={root}>{root.slice(root.lastIndexOf("/") + 1) || root}</span>
        <button
          className={`sb-icon-btn${showHidden ? " sb-active" : ""}`}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
          onClick={() => setShowHidden((v) => !v)}
        >
          {/* eye */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
            <circle cx="8" cy="8" r="2" />
            {!showHidden && <path d="M2 14L14 2" />}
          </svg>
        </button>
        <button className="sb-icon-btn" title="Refresh explorer, git status and open files from disk" onClick={refresh}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" />
          </svg>
        </button>
        <button className="sb-icon-btn" title="Collapse all" onClick={collapseAll}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M4 10l4-4 4 4" />
          </svg>
        </button>
      </div>
      <div className="sb-scroll sb-tree-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
        {rootError && <div className="sb-empty sb-error">{rootError}</div>}
        {!rootError && !children.has(root) && <div className="sb-empty">Loading…</div>}
        {!rootError && children.get(root)?.length === 0 && <div className="sb-empty">Empty folder</div>}
        {rows.map(({ entry, depth }) => {
          const isOpen = entry.isDir && expanded.has(entry.path);
          const d = lookupDecor(decor, entry.path);
          const hasChanges = entry.isDir && !d && decor.dirs.has(entry.path);
          const err = entry.isDir && isOpen ? errors.get(entry.path) : undefined;
          return (
            <div key={entry.path}>
              <div
                className={`sb-row${selected === entry.path ? " sb-selected" : ""}${d ? ` sb-git-${d.kind}` : ""}`}
                data-path={entry.path}
                style={{ paddingLeft: 6 + depth * ROW_INDENT }}
                title={entry.path}
                onClick={() => activate(entry)}
                onDoubleClick={() => !entry.isDir && onOpenFile(entry.path, false)}
              >
                <span className="sb-twisty">
                  {entry.isDir && (
                    <svg width="10" height="10" viewBox="0 0 10 10" className={isOpen ? "sb-open" : ""}>
                      <path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                  )}
                </span>
                <FileIcon name={entry.name} dir={entry.isDir} open={isOpen} />
                <span className={`sb-name${entry.name.startsWith(".") ? " sb-dim" : ""}${entry.isSymlink ? " sb-symlink" : ""}`}>
                  {entry.name}
                </span>
                {d && <span className="sb-badge">{d.letter}</span>}
                {hasChanges && <span className="sb-dot" title="Contains changes" />}
              </div>
              {err && (
                <div className="sb-row sb-error" style={{ paddingLeft: 6 + (depth + 1) * ROW_INDENT + 14 }}>{err}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
