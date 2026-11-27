// Keyboard pickers: ⌘P quick open (files by name), ⇧⌘F search in files, ⌘O switch project
// (open and recent projects). Mounted once by App via <SearchHost />.
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import { PALETTE, useWorkspace } from "../store/workspace";
import type { RecentPath } from "../types";
import { requestReveal } from "../components/editor/reveal";
import { FileIcon } from "../components/FileIcon";
import { Icon } from "../components/icons";
import { fuzzyFilter, type FuzzyMatch } from "./fuzzy";
import "./search.css";

type Kind = "files" | "text" | "projects";
export const useSearchUI = create<{ open: Kind | null; show(k: Kind): void; close(): void }>((set) => ({
  open: null,
  show: (k) => set({ open: k }),
  close: () => set({ open: null }),
}));

interface SearchHit { path: string; line: number; column: number; text: string }
const searchApi = {
  files: (root: string) => invoke<string[]>("project_files", { root }),
  search: (root: string, query: string, opts: { regex: boolean; caseSensitive: boolean; wholeWord: boolean; maxResults: number }) =>
    invoke<{ hits: SearchHit[]; truncated: boolean }>("project_search", { root, query, opts }),
};

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
const base = (p: string) => trim(p).split("/").pop() || p;

function activeProject() {
  const s = useWorkspace.getState();
  return s.activeProjectId ? s.projects[s.activeProjectId] : null;
}

function openFile(rel: string, line?: number, column?: number) {
  const p = activeProject();
  if (!p) return;
  const abs = `${trim(p.rootPath)}/${rel}`;
  if (line) requestReveal(abs, line, column);
  useWorkspace.getState().openEditor(p.id, abs, {});
}

/** Text with matched characters highlighted. */
function Marked({ text, positions, offset = 0 }: { text: string; positions: number[]; offset?: number }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions.map((p) => p - offset));
  const out: React.ReactNode[] = [];
  let run = "";
  let on = false;
  const flush = (k: number) => {
    if (run) out.push(on ? <mark key={k}>{run}</mark> : <span key={k}>{run}</span>);
    run = "";
  };
  [...text].forEach((ch, i) => {
    const m = set.has(i);
    if (m !== on) {
      flush(i);
      on = m;
    }
    run += ch;
  });
  flush(text.length);
  return <>{out}</>;
}

/** Shared shell: input on top, a keyboard-driven list below. */
function PickerShell<T>(props: {
  placeholder: string;
  query: string;
  setQuery(q: string): void;
  items: T[];
  render(item: T, active: boolean): React.ReactNode;
  onPick(item: T, e: React.KeyboardEvent | React.MouseEvent): void;
  status?: React.ReactNode;
  toolbar?: React.ReactNode;
  empty: string;
}) {
  const close = useSearchUI((s) => s.close);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [props.items]);
  useEffect(() => {
    listRef.current?.querySelector(".pk-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className="pk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pk" role="dialog" aria-label={props.placeholder}>
        <div className="pk-input-row">
          <Icon name="search" size={14} />
          <input
            autoFocus
            className="pk-input"
            placeholder={props.placeholder}
            value={props.query}
            spellCheck={false}
            onChange={(e) => props.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, props.items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const it = props.items[active];
                if (it) props.onPick(it, e);
              }
            }}
          />
          {props.toolbar}
        </div>
        <div className="pk-list" ref={listRef} role="listbox">
          {props.items.length === 0 && <div className="pk-empty">{props.empty}</div>}
          {props.items.map((it, i) => (
            <div
              key={i}
              role="option"
              aria-selected={i === active}
              className={`pk-item${i === active ? " active" : ""}`}
              onMouseMove={() => i !== active && setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                props.onPick(it, e);
              }}
            >
              {props.render(it, i === active)}
            </div>
          ))}
        </div>
        {props.status && <div className="pk-status">{props.status}</div>}
      </div>
    </div>
  );
}

// ---------------- ⌘P quick open ----------------

const fileCache = new Map<string, { at: number; files: string[] }>();

function QuickOpen() {
  const close = useSearchUI((s) => s.close);
  const project = activeProject();
  const root = project ? trim(project.rootPath) : "";
  const [files, setFiles] = useState<string[]>(() => fileCache.get(root)?.files ?? []);
  const [loading, setLoading] = useState(!fileCache.has(root));
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!root) return;
    const cached = fileCache.get(root);
    if (cached && Date.now() - cached.at < 5000) return;
    searchApi
      .files(root)
      .then((f) => {
        fileCache.set(root, { at: Date.now(), files: f });
        setFiles(f);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [root]);
  const results = useMemo<{ item: string; match: FuzzyMatch }[]>(
    () => (query.trim() ? fuzzyFilter(files, query, (f) => f, 100) : files.slice(0, 100).map((f) => ({ item: f, match: { score: 0, positions: [] } }))),
    [files, query],
  );
  if (!project) return null;
  return (
    <PickerShell
      placeholder={`Go to file in ${project.name}`}
      query={query}
      setQuery={setQuery}
      items={results}
      empty={loading ? "Listing files…" : error ?? "No matching files"}
      status={<>{files.length.toLocaleString()} files · <kbd>↵</kbd> open</>}
      onPick={(r) => {
        close();
        openFile(r.item);
      }}
      render={(r) => {
        const slash = r.item.lastIndexOf("/");
        const name = r.item.slice(slash + 1);
        const dir = slash >= 0 ? r.item.slice(0, slash) : "";
        return (
          <>
            <FileIcon name={name} />
            <span className="pk-name"><Marked text={name} positions={r.match.positions} offset={slash + 1} /></span>
            <span className="pk-dim"><Marked text={dir} positions={r.match.positions.filter((p) => p < slash)} /></span>
          </>
        );
      }}
    />
  );
}

// ---------------- ⇧⌘F search in files ----------------

const SEARCH_KEY = "tcon.search.opts";
function loadOpts() {
  try {
    return { regex: false, caseSensitive: false, wholeWord: false, ...JSON.parse(localStorage.getItem(SEARCH_KEY) ?? "{}") };
  } catch {
    return { regex: false, caseSensitive: false, wholeWord: false };
  }
}
let lastQuery = "";

function SearchInFiles() {
  const close = useSearchUI((s) => s.close);
  const project = activeProject();
  const root = project ? trim(project.rootPath) : "";
  const [query, setQuery] = useState(lastQuery);
  const [opts, setOpts] = useState(loadOpts);
  const [res, setRes] = useState<{ hits: SearchHit[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(SEARCH_KEY, JSON.stringify(opts));
    } catch {
      /* unavailable */
    }
  }, [opts]);
  useEffect(() => {
    lastQuery = query;
    if (!root || query.length < 2) {
      setRes(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setBusy(true);
      searchApi
        .search(root, query, { ...opts, maxResults: 2000 })
        .then((r) => !cancelled && (setRes(r), setError(null)))
        .catch((e) => !cancelled && setError(String(e)))
        .finally(() => !cancelled && setBusy(false));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [root, query, opts]);
  if (!project) return null;
  const hits = res?.hits ?? [];
  const files = new Set(hits.map((h) => h.path)).size;
  const toggle = (k: "regex" | "caseSensitive" | "wholeWord", label: string, title: string) => (
    <button className={`pk-opt${opts[k] ? " on" : ""}`} title={title} aria-pressed={opts[k]} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpts((o: typeof opts) => ({ ...o, [k]: !o[k] }))}>
      {label}
    </button>
  );
  const needle = (text: string) => {
    if (opts.regex) return null;
    const i = opts.caseSensitive ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
    return i >= 0 ? [i, i + query.length] : null;
  };
  return (
    <PickerShell
      placeholder={`Search in ${project.name}`}
      query={query}
      setQuery={setQuery}
      items={hits}
      empty={query.length < 2 ? "Type at least 2 characters" : busy ? "Searching…" : error ?? "No results"}
      toolbar={<span className="pk-opts">{toggle("caseSensitive", "Aa", "Match case")}{toggle("wholeWord", "ab", "Whole word")}{toggle("regex", ".*", "Regular expression")}</span>}
      status={res ? <>{hits.length.toLocaleString()}{res.truncated ? "+" : ""} results in {files} files{busy ? " · searching…" : ""} · <kbd>↵</kbd> open at line</> : undefined}
      onPick={(h) => {
        close();
        openFile(h.path, h.line, h.column);
      }}
      render={(h) => {
        const text = h.text.replace(/^\s+/, "");
        const m = needle(text);
        return (
          <>
            <FileIcon name={base(h.path)} />
            <span className="pk-hit">
              {m ? <>{text.slice(0, m[0])}<mark>{text.slice(m[0], m[1])}</mark>{text.slice(m[1])}</> : text}
            </span>
            <span className="pk-dim pk-loc" title={`${h.path}:${h.line}:${h.column}`}>{h.path}:{h.line}</span>
          </>
        );
      }}
    />
  );
}

// ---------------- ⌘O project switcher ----------------

interface ProjectItem { path: string; name: string; color: string | null; projectId: string | null; pinned: boolean }

function ProjectSwitcher() {
  const close = useSearchUI((s) => s.close);
  const projects = useWorkspace((s) => s.order.map((id) => s.projects[id]).filter(Boolean));
  const activeId = useWorkspace((s) => s.activeProjectId);
  const [recent, setRecent] = useState<RecentPath[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => void api.recentList(100).then(setRecent).catch(() => setRecent([])), []);
  const items = useMemo(() => {
    const open: ProjectItem[] = projects
      .filter((p) => p.id !== activeId)
      .concat(projects.filter((p) => p.id === activeId))
      .map((p) => ({ path: trim(p.rootPath), name: p.name, color: p.color, projectId: p.id, pinned: false }));
    const openPaths = new Set(open.map((o) => o.path));
    const closed: ProjectItem[] = recent
      .filter((r) => !openPaths.has(trim(r.path)))
      .map((r) => ({ path: trim(r.path), name: base(r.path), color: null, projectId: null, pinned: r.pinned }));
    const all = [...open, ...closed];
    if (!query.trim()) return all.map((item) => ({ item, match: null as FuzzyMatch | null }));
    return fuzzyFilter(all, query, (x) => `${x.name} ${tilde(x.path)}`, 100);
  }, [projects, activeId, recent, query]);
  return (
    <PickerShell
      placeholder="Switch to a project (open or recent)"
      query={query}
      setQuery={setQuery}
      items={items}
      empty="No matching projects"
      status={<><kbd>↵</kbd> switch / open · <kbd>⌘↵</kbd> open with Claude · <button className="pk-link" onMouseDown={(e) => e.preventDefault()} onClick={() => { close(); useWorkspace.getState().setModal({ kind: "newProject" }); }}>Browse…</button></>}
      onPick={({ item }, e) => {
        close();
        const ws = useWorkspace.getState();
        if (item.projectId) return ws.setActive(item.projectId);
        const claude = "metaKey" in e && (e.metaKey || e.ctrlKey);
        ws.openProject({ path: item.path, color: PALETTE[ws.order.length % PALETTE.length], profileId: null, claude });
      }}
      render={({ item, match }) => (
        <>
          <span className="pk-dot" style={{ background: item.color ?? "transparent", borderColor: item.color ?? "var(--fg-dim)" }} />
          <span className="pk-name">{match ? <Marked text={item.name} positions={match.positions} /> : item.name}</span>
          <span className="pk-dim">{tilde(item.path)}</span>
          <span className="pk-badge">{item.projectId ? (item.projectId === activeId ? "current" : "open") : item.pinned ? "pinned" : "recent"}</span>
        </>
      )}
    />
  );
}

export function SearchHost() {
  const open = useSearchUI((s) => s.open);
  const hasProject = useWorkspace((s) => !!s.activeProjectId);
  if (open === "projects") return <ProjectSwitcher />;
  if (!hasProject) return null;
  if (open === "files") return <QuickOpen />;
  if (open === "text") return <SearchInFiles />;
  return null;
}
