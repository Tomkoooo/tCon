// The quick panel: a Spotlight-like window (label `quick`, see src-tauri/src/background.rs)
// toggled by a global shortcut from any app. Pick a project, type a task, Enter. Below the
// input a compact kanban of that project.
//
// Deliberately light: it doesn't load the workbench stores, terminals or watchers. It may
// only call the few commands in capabilities/quick.json. Task files are written by the same
// Rust code as the main window (fresh read-modify-write under one lock), so both windows can
// add tasks at the same time without clobbering each other.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BoardState, Task } from "../tasks/types";
import { BUILTIN_THEMES } from "../theming/builtin";
import { computeTokens } from "../theming/tokens";
import { parseQuickInput } from "./parse";
import { applyCachedVars } from "./theme";
import "./quick.css";

interface QuickProject {
  path: string;
  name: string;
  color: string | null;
  open: boolean;
  active: boolean;
}

const LAST_ROOT_KEY = "tcon.quick.lastRoot";
const PROJECTS_KEY = "tcon.quick.projects";
const HIDDEN_COLS = new Set(["done"]);
const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";

/** Theme: the main window's cached one, or the built-in dark/light. */
export function applyQuickTheme() {
  if (applyCachedVars()) return;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const t = BUILTIN_THEMES[dark ? 0 : 1];
  const vars = computeTokens(t.colors ?? {}, dark ? "dark" : "light");
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = dark ? "dark" : "light";
}

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, v: string) {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* unavailable */
    }
  },
};

const api = {
  projects: () => invoke<QuickProject[]>("quick_projects"),
  load: (root: string) => invoke<BoardState>("tasks_load", { root }),
  create: (root: string, title: string, description: string, status: string) => invoke<Task>("task_create", { root, title, description, status }),
  update: (root: string, id: string, patch: { priority?: string; labels?: string[] }) => invoke<Task>("task_update", { root, id, patch }),
  hide: () => invoke<void>("quick_hide"),
  open: (root: string, taskId: string | null) => invoke<void>("quick_open", { root, taskId }),
};

/** Boards read this session, per root: shown instantly when switching back. */
const boardCache = new Map<string, BoardState>();

function cachedProjects(): QuickProject[] {
  try {
    const v = JSON.parse(store.get(PROJECTS_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");

export function QuickPanel() {
  const [projects, setProjects] = useState<QuickProject[]>(cachedProjects);
  const [root, setRoot] = useState<string | null>(() => store.get(LAST_ROOT_KEY) ?? cachedProjects()[0]?.path ?? null);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  const lastActive = useRef<string | null>(null);

  const reload = useCallback(async (r: string | null = rootRef.current) => {
    if (!r) return;
    try {
      const st = await api.load(r);
      boardCache.set(r, st);
      if (rootRef.current === r) {
        setBoard(st);
        setError(null);
      }
    } catch (e) {
      if (rootRef.current === r) setError(errText(e));
    }
  }, []);

  /** Refresh the project list. On show, follow the main window's active project when it changed. */
  const loadProjects = useCallback(async (followActive: boolean) => {
    let list: QuickProject[];
    try {
      list = await api.projects();
    } catch {
      return;
    }
    setProjects(list);
    store.set(PROJECTS_KEY, JSON.stringify(list));
    const active = list.find((p) => p.active)?.path ?? null;
    const cur = rootRef.current;
    let next = cur && list.some((p) => p.path === cur) ? cur : null;
    if (followActive && active && active !== lastActive.current) next = active;
    if (active) lastActive.current = active;
    next ??= active ?? list[0]?.path ?? null;
    if (next !== cur) setRoot(next);
  }, []);

  const focusInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Switching project: cached board at once, then the disk.
  useEffect(() => {
    setBoard(root ? boardCache.get(root) ?? null : null);
    setError(null);
    if (root) {
      store.set(LAST_ROOT_KEY, root);
      void reload(root);
    }
  }, [root, reload]);

  useEffect(() => {
    void loadProjects(true);
    focusInput();
    const offs = [
      listen("quick-shown", () => {
        applyQuickTheme();
        setNotice(null);
        void loadProjects(true);
        void reload();
        focusInput();
      }),
      // Task files changed (only reported for projects open in the main window).
      listen<{ root: string; paths: string[] }>("fs-changed", ({ payload }) => {
        const r = rootRef.current;
        if (r && payload.root.replace(/\/+$/, "") === r && payload.paths.some((p) => p.includes("/.tcon/"))) void reload(r);
      }),
    ];
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    // Projects not open in the main window have no watcher: poll while visible.
    const poll = window.setInterval(() => document.hasFocus() && void reload(), 4000);
    return () => {
      offs.forEach((p) => p.then((f) => f()).catch(() => {}));
      window.removeEventListener("focus", onFocus);
      window.clearInterval(poll);
    };
  }, [loadProjects, reload, focusInput]);

  // Keep the selected project chip in view.
  useLayoutEffect(() => {
    chipsRef.current?.querySelector(".qp-chip.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [root, projects]);

  const cycle = (delta: number) => {
    if (!projects.length) return;
    const i = projects.findIndex((p) => p.path === root);
    setRoot(projects[(i + delta + projects.length) % projects.length].path);
  };

  const submit = async (status: "inbox" | "todo") => {
    const r = root;
    const parsed = parseQuickInput(text);
    if (!r || !parsed.title) return;
    try {
      let t = await api.create(r, parsed.title, parsed.description, status);
      if (parsed.priority || parsed.labels.length) {
        t = await api.update(r, t.id, { ...(parsed.priority ? { priority: parsed.priority } : {}), ...(parsed.labels.length ? { labels: parsed.labels } : {}) });
      }
      setText("");
      setFresh(t.id);
      window.setTimeout(() => setFresh((f) => (f === t.id ? null : f)), 1600);
      setNotice({ text: `Added ${t.id} to ${status === "todo" ? "Todo" : "Inbox"}` });
      // Show it right away; the reload confirms.
      setBoard((b) => (b && rootRef.current === r ? { ...b, tasks: [...b.tasks, t], columns: { ...b.columns, [t.status]: [...(b.columns[t.status] ?? []), t.id] } } : b));
      void reload(r);
    } catch (e) {
      setNotice({ text: errText(e), error: true });
    }
  };

  // Window-level keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        if (document.activeElement === filterRef.current && filter) return setFilter("");
        if (document.activeElement === filterRef.current) return focusInput();
        void api.hide();
        return;
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const p = projects[Number(e.key) - 1];
        if (p) setRoot(p.path);
        return;
      }
      if (mod && (e.key === "k" || e.key === "f")) {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
        return;
      }
      if (e.key === "Tab" && !mod && !e.altKey) {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e.metaKey || e.ctrlKey ? "todo" : "inbox");
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !text.includes("\n") && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      cycle(e.key === "ArrowUp" ? -1 : 1);
    }
  };

  // Auto-grow the input up to 4 lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 104)}px`;
  }, [text]);

  const project = projects.find((p) => p.path === root) ?? null;
  const parsed = useMemo(() => parseQuickInput(text), [text]);

  const columns = useMemo(() => {
    if (!board) return [];
    const byId = new Map(board.tasks.map((t) => [t.id, t]));
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (t: Task) => {
      if (!words.length) return true;
      const hay = `${t.id} ${t.title} ${t.labels.join(" ")} ${t.priority}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    };
    return board.board.columns.map((c) => ({
      ...c,
      tasks: (board.columns[c.id] ?? []).map((id) => byId.get(id)).filter((t): t is Task => !!t && match(t)),
    }));
  }, [board, filter]);

  return (
    <div className="qp">
      <div className="qp-projects" ref={chipsRef} role="tablist" aria-label="Project">
        {projects.length === 0 && <span className="qp-dim">No projects yet. Open one in tCon first.</span>}
        {projects.map((p, i) => (
          <button
            key={p.path}
            role="tab"
            aria-selected={p.path === root}
            className={`qp-chip${p.path === root ? " on" : ""}`}
            title={tilde(p.path)}
            onClick={() => {
              setRoot(p.path);
              focusInput();
            }}
          >
            <span className="qp-dot" style={{ background: p.color ?? "var(--fg-dim)", opacity: p.open ? 1 : 0.45 }} />
            {p.name}
            {i < 9 && <span className="qp-kbd">{MOD}{i + 1}</span>}
          </button>
        ))}
      </div>

      <div className="qp-input-row">
        <svg className="qp-plus" width="18" height="18" viewBox="0 0 16 16" aria-hidden>
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <textarea
          ref={inputRef}
          className="qp-input"
          rows={1}
          value={text}
          spellCheck={false}
          placeholder={project ? `Add a task to ${project.name}…` : "Pick a project…"}
          disabled={!project}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onInputKey}
          aria-label="New task"
        />
        {(parsed.priority || parsed.labels.length > 0) && (
          <div className="qp-tokens">
            {parsed.priority && <span className={`qp-tag qp-prio-${parsed.priority}`}>!{parsed.priority}</span>}
            {parsed.labels.map((l) => (
              <span key={l} className="qp-tag">#{l}</span>
            ))}
          </div>
        )}
      </div>

      <div className="qp-bar">
        <input
          ref={filterRef}
          className="qp-filter"
          value={filter}
          placeholder={`Filter tasks  ${MOD}K`}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && focusInput()}
          aria-label="Filter tasks"
        />
        {notice && <span className={`qp-notice${notice.error ? " error" : ""}`}>{notice.text}</span>}
      </div>

      <div className="qp-board">
        {error && <div className="qp-empty error">{error}</div>}
        {!error && board && !board.initialized && board.tasks.length === 0 && (
          <div className="qp-empty">No board in this project yet. Adding a task creates it (.tcon/).</div>
        )}
        {!error &&
          board &&
          (board.initialized || board.tasks.length > 0) &&
          columns.map((c) =>
            HIDDEN_COLS.has(c.id) && !showDone && !filter ? (
              <button key={c.id} className="qp-col qp-col-collapsed" onClick={() => setShowDone(true)} title={`Show ${c.title}`}>
                <StatusGlyph status={c.id} />
                <span className="qp-col-vtitle">{c.title}</span>
                <span className="qp-count">{c.tasks.length}</span>
              </button>
            ) : (
              <section key={c.id} className="qp-col" aria-label={c.title}>
                <header className="qp-col-head" onClick={HIDDEN_COLS.has(c.id) ? () => setShowDone(false) : undefined}>
                  <StatusGlyph status={c.id} />
                  <span>{c.title}</span>
                  <span className="qp-count">{c.tasks.length}</span>
                </header>
                <div className="qp-cards">
                  {c.tasks.map((t) => (
                    <button
                      key={t.id}
                      className={`qp-card${fresh === t.id ? " fresh" : ""}`}
                      onClick={() => root && void api.open(root, t.id)}
                      title="Open in tCon"
                    >
                      <div className="qp-card-top">
                        <span className="qp-id">{t.id}</span>
                        <PriorityGlyph priority={t.priority} />
                        {t.agent && t.agent !== "idle" && <span className={`qp-agent qp-agent-${t.agent}`}>{t.agent}</span>}
                      </div>
                      <div className="qp-title">{t.title}</div>
                      {t.labels.length > 0 && (
                        <div className="qp-labels">
                          {t.labels.slice(0, 3).map((l) => (
                            <span key={l}>#{l}</span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ),
          )}
      </div>

      <footer className="qp-foot">
        <span><kbd>↵</kbd> Inbox</span>
        <span><kbd>{MOD}↵</kbd> Todo</span>
        <span><kbd>⇧↵</kbd> Description</span>
        <span><kbd>#label</kbd> <kbd>!high</kbd></span>
        <span><kbd>⇥</kbd> Project</span>
        {project && (
          <button className="qp-link" onClick={() => root && void api.open(root, null)}>
            Open in tCon
          </button>
        )}
        <span><kbd>esc</kbd> Close</span>
      </footer>
    </div>
  );
}

function StatusGlyph({ status }: { status: string }) {
  const frac = status === "in-progress" ? 0.5 : status === "review" ? 0.75 : 0;
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`qp-st qp-st-${status}`} width="12" height="12" viewBox="0 0 14 14" aria-hidden>
      {status === "done" ? (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={status === "inbox" ? "2 1.6" : undefined} />
          {frac > 0 && <circle cx="7" cy="7" r={r / 2} fill="none" stroke="currentColor" strokeWidth={r} strokeDasharray={`${(c / 2) * frac} ${c}`} transform="rotate(-90 7 7)" />}
        </>
      )}
    </svg>
  );
}

function PriorityGlyph({ priority }: { priority: string }) {
  if (!priority || priority === "none") return null;
  if (priority === "urgent") {
    return (
      <svg className="qp-prio qp-prio-urgent" width="12" height="12" viewBox="0 0 14 14" aria-label="Urgent">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <path d="M7 3.8v3.8M7 9.6v.6" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  const n = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg className="qp-prio" width="12" height="12" viewBox="0 0 14 14" aria-label={priority}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.6" height={3 + i * 3} rx="0.8" fill="currentColor" opacity={i < n ? 1 : 0.3} />
      ))}
    </svg>
  );
}
