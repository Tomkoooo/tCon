import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../api";
import type { FsChangedEvent, GitBranch, GitCommit, GitCommitDetails, GitFileStatus, GitOp, GitStatus, GitWorktree } from "../../types";
import { refreshGitForRoot } from "../../store/gitRefresh";
import { onRefresh } from "../../refresh";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { computeGraph, graphColor, laneX, segmentPath } from "./graphLayout";
import type { GraphGeometry, GraphRow } from "./graphLayout";
import { CommitCard, RefPills, refPills, SYNC_NOTE, type CommitActions, type RefContext } from "./commitCard";
import { commitWebUrl, remoteToWeb } from "./gitWeb";
import { writeText } from "../workbench/clipboard";
import { useWorkspace } from "../../store/workspace";
import { baseName, decorFor, parentDir, trimSlash } from "./gitDecor";
import "./sidebar.css";
import { FileIcon } from "../FileIcon";
import { Icon } from "../icons";

export interface GitPanelProps {
  root: string;
  gitStatus?: GitStatus | null;
  onOpenDiff?(file: string | null, staged: boolean): void;
  onOpenFile?(path: string): void;
}

interface RowActions {
  stage(f: GitFileStatus): void;
  unstage(f: GitFileStatus): void;
  discard(f: GitFileStatus): void;
  open?(f: GitFileStatus): void;
}

const LOG_LIMIT = 300;
const ROW_H = 22;
const LANE_W = 12;
const MAX_GRAPH_LANES = 14;
const GEOM: GraphGeometry = { laneW: LANE_W, rowH: ROW_H, pad: 2 };
const HOVER_OPEN_MS = 400;
const HOVER_SWITCH_MS = 120;
const HOVER_CLOSE_MS = 220;
const SCOPE_KEY = "tcon.git.graphScope";
type GraphScope = "auto" | "all";
const loadScope = (): GraphScope => {
  try {
    return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "auto";
  } catch {
    return "auto";
  }
};

type SectionId = "changes" | "worktrees" | "branches" | "graph";

function Section(props: {
  id: SectionId;
  title: string;
  count?: number;
  open: boolean;
  onToggle(id: SectionId): void;
  actions?: ReactNode;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`sb-section${props.open ? " sb-section-open" : ""}${props.grow && props.open ? " sb-section-grow" : ""}`}>
      <div className="sb-section-header" role="button" tabIndex={0} aria-expanded={props.open} onClick={() => props.onToggle(props.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), props.onToggle(props.id))}>
        <Icon name="chevronRight" size={14} className={`sb-chevron${props.open ? " sb-open" : ""}`} />
        <span className="sb-section-title">{props.title}</span>
        {props.count !== undefined && <span className="sb-count">{props.count}</span>}
        <span className="sb-spacer" />
        {props.actions && <span className="sb-section-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{props.actions}</span>}
      </div>
      {props.open && <div className="sb-section-body">{props.children}</div>}
    </div>
  );
}

const NODE_BG = "var(--sidebar-bg, var(--bg-2))";

/** One row of the graph: lanes, curved fork/merge connectors and the node (dot, merge ring, or HEAD circle). */
const GraphCell = memo(function GraphCell({ row, lanes, sync, head }: { row: GraphRow; lanes: number; sync?: string | null; head: boolean }) {
  // Size each row to the lanes it actually draws (like VS Code), so the message and ref badges
  // sit right next to the commit dot instead of aligning to the widest row. `lanes` caps it.
  const used = row.segments.reduce((m, s) => Math.max(m, s.x1 + 1, s.x2 + 1), Math.max(row.width, row.lane + 1));
  const w = Math.min(lanes, used) * LANE_W + GEOM.pad * 2;
  const cx = laneX(row.lane, GEOM);
  const cy = ROW_H / 2;
  const col = graphColor(row.color);
  return (
    <svg className="sb-graph-svg" width={w} height={ROW_H} viewBox={`0 0 ${w} ${ROW_H}`} aria-hidden>
      {row.segments.map((s, i) => (
        <path key={i} d={segmentPath(s, GEOM)} fill="none" stroke={graphColor(s.color)} strokeWidth={1.5} strokeLinecap="round" />
      ))}
      {head ? (
        <circle cx={cx} cy={cy} r={5} fill={NODE_BG} stroke={col} strokeWidth={2} />
      ) : row.isMerge ? (
        <>
          <circle cx={cx} cy={cy} r={4.25} fill={NODE_BG} stroke={col} strokeWidth={1.5} />
          <circle cx={cx} cy={cy} r={1.75} fill={col} />
        </>
      ) : sync === "incoming" ? (
        // not pulled yet: a hollow, dashed "ghost" dot
        <circle cx={cx} cy={cy} r={3.25} fill={NODE_BG} stroke={col} strokeWidth={1.25} strokeDasharray="2 1.4" />
      ) : (
        <circle cx={cx} cy={cy} r={3.25} fill={col} />
      )}
    </svg>
  );
});

/** Graph rows show a short subject (the hover card has the full message), so ref badges stay visible. */
const SUBJECT_MAX = 40;
function shortSubject(summary: string): string {
  if (summary.length <= SUBJECT_MAX) return summary;
  const cut = summary.slice(0, SUBJECT_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SUBJECT_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.:;(-]+$/, "")}…`;
}

const relPath = (file: GitFileStatus) => trimSlash(file.path.includes(" -> ") ? file.path.split(" -> ")[1] : file.path);

function ChangeRow({ file, staged, onOpenDiff, actions, busy }: {
  file: GitFileStatus; staged: boolean; onOpenDiff?: GitPanelProps["onOpenDiff"]; actions: RowActions; busy: boolean;
}) {
  const d = decorFor(staged ? { ...file, worktree: " " } : file.index === "?" ? file : { ...file, index: " " });
  const rel = relPath(file);
  const dir = rel.includes("/") ? parentDir(rel) : "";
  const deleted = (staged ? file.index : file.worktree) === "D";
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!busy) fn();
  };
  return (
    <div
      className={`sb-row sb-change sb-git-${d.kind}`}
      style={{ paddingLeft: 22 }}
      title={`${file.path} — ${staged ? "staged" : "working tree"}`}
      onClick={() => onOpenDiff?.(rel, staged)}
    >
      <FileIcon name={baseName(rel)} />
      <span className="sb-name">{baseName(rel)}</span>
      {dir && <span className="sb-desc">{dir}</span>}
      <span className="sb-spacer" />
      <span className="sb-row-actions">
        {actions.open && !deleted && (
          <button className="sb-icon-btn" title="Open file" onClick={stop(() => actions.open!(file))}><Icon name="file" /></button>
        )}
        {!staged && (
          <button className="sb-icon-btn" title="Discard changes" onClick={stop(() => actions.discard(file))}><Icon name="discard" /></button>
        )}
        {staged ? (
          <button className="sb-icon-btn" title="Unstage" onClick={stop(() => actions.unstage(file))}><Icon name="minus" /></button>
        ) : (
          <button className="sb-icon-btn" title="Stage" onClick={stop(() => actions.stage(file))}><Icon name="plus" /></button>
        )}
      </span>
      <span className="sb-badge">{d.letter}</span>
    </div>
  );
}

export function GitPanel({ root: rawRoot, gitStatus, onOpenDiff, onOpenFile }: GitPanelProps) {
  const root = trimSlash(rawRoot);
  const [open, setOpen] = useState<Record<SectionId, boolean>>({ changes: true, worktrees: false, branches: false, graph: true });
  const [showRemotes, setShowRemotes] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const toggle = useCallback((id: SectionId) => setOpen((o) => ({ ...o, [id]: !o[id] })), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [opInfo, setOpInfo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState<string | null>(null);
  /** start point of the branch being created ("Create branch here…"), null = HEAD */
  const [newBranchFrom, setNewBranchFrom] = useState<GitCommit | null>(null);
  const menu = useContextMenu();
  const reloadRef = useRef<() => void>(() => {});
  const [scope, setScopeState] = useState<GraphScope>(loadScope);
  const setScope = (v: GraphScope) => {
    setScopeState(v);
    try {
      localStorage.setItem(SCOPE_KEY, v);
    } catch { /* storage unavailable */ }
  };

  const reload = useCallback(async (isCancelled: () => boolean) => {
    const [log, br, wt] = await Promise.allSettled([
      api.gitLog(root, LOG_LIMIT, scope === "auto"),
      api.gitBranches(root),
      api.gitWorktrees(root),
    ]);
    if (isCancelled()) return;
    setCommits(log.status === "fulfilled" ? log.value : []);
    setBranches(br.status === "fulfilled" ? br.value : []);
    setWorktrees(wt.status === "fulfilled" ? wt.value : []);
    setError(log.status === "rejected" ? String(log.reason) : null);
    setLoaded(true);
  }, [root, scope]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    const isCancelled = () => cancelled;
    reloadRef.current = () => void reload(isCancelled);
    setLoaded(false);
    setCommits([]);
    setBranches([]);
    setWorktrees([]);
    void reload(isCancelled);
    const offRefresh = onRefresh(root, () => void reload(isCancelled));
    listen<FsChangedEvent>("fs-changed", (ev) => {
      if (!ev.payload.git || trimSlash(ev.payload.root) !== root) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(isCancelled), 300);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    }).catch(() => { /* not running inside Tauri */ });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
      offRefresh();
    };
  }, [root, reload]);

  const graph = useMemo(() => computeGraph(commits), [commits]);
  const graphLanes = useMemo(
    () => Math.min(MAX_GRAPH_LANES, graph.reduce((m, r) => Math.max(m, r.width), 1)),
    [graph],
  );
  const syncCounts = useMemo(() => {
    const c = { outgoing: 0, incoming: 0, local: 0, total: 0 };
    for (const x of commits) if (x.sync) { c[x.sync]++; c.total++; }
    return c;
  }, [commits]);

  // ---- commit details (lazy, cached per root) + hover card ----
  const detailsCache = useRef(new Map<string, GitCommitDetails | string>());
  const [, bumpDetails] = useState(0);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  useEffect(() => {
    detailsCache.current.clear();
    setRemoteUrl(null);
  }, [root]);
  const loadDetails = useCallback((id: string) => {
    if (detailsCache.current.has(id)) return;
    detailsCache.current.set(id, "");
    api.gitCommitDetails(root, id).then((d) => {
      detailsCache.current.set(id, d);
      if (d.remoteUrl !== undefined) setRemoteUrl(d.remoteUrl ?? null);
    }).catch((e: unknown) => {
      detailsCache.current.set(id, String(e));
    }).finally(() => bumpDetails((n) => n + 1));
  }, [root]);
  // The newest commit's details also tell us the remote URL (for "Open on GitHub" in the context menu).
  useEffect(() => {
    if (commits[0]) loadDetails(commits[0].id);
  }, [commits, loadDetails]);

  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverOpen = useRef(false);
  hoverOpen.current = !!hover;
  const closeCard = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    setHover(null);
  }, []);
  const keepCard = useCallback(() => clearTimeout(closeTimer.current), []);
  const leaveCard = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHover(null), HOVER_CLOSE_MS);
  }, []);
  const enterRow = (id: string, el: HTMLElement) => {
    clearTimeout(closeTimer.current);
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      if (!el.isConnected) return;
      loadDetails(id);
      setHover({ id, rect: el.getBoundingClientRect() });
    }, hoverOpen.current ? HOVER_SWITCH_MS : HOVER_OPEN_MS);
  };
  useEffect(() => () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);

  const headId = useMemo(() => commits.find((c) => c.refs.includes("HEAD"))?.id ?? null, [commits]);
  const refCtx: RefContext = useMemo(() => ({
    localNames: new Set(branches.filter((b) => !b.isRemote).map((b) => b.name)),
    remoteNames: new Set(branches.filter((b) => b.isRemote).map((b) => b.name)),
    upstreamOf: new Map(branches.filter((b) => !b.isRemote && b.upstream).map((b) => [b.name, b.upstream!])),
    headBranch: gitStatus?.branch ?? null,
  }), [branches, gitStatus?.branch]);
  const repoName = (gitStatus?.root ?? root).split("/").filter(Boolean).pop() ?? root;
  const graphRef = useRef<HTMLDivElement>(null);
  const goToCurrent = () => {
    const el = graphRef.current?.querySelector<HTMLElement>(".sb-graph-head");
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("sb-flash");
    void el.offsetWidth;
    el.classList.add("sb-flash");
  };

  const commitActions: CommitActions = {
    openWeb: (url) => void openUrl(url).catch((e: unknown) => setOpError(String(e))),
    copy: (text) => void writeText(text),
    checkout: (c) => {
      closeCard();
      void run("Checking out…", { op: "checkoutDetached", commit: c.id }, `HEAD is now at ${c.shortId} (detached).`);
    },
    createBranch: (c) => {
      closeCard();
      setNewBranchFrom(c);
      setNewBranch("");
    },
    openChanges: (c) => {
      closeCard();
      const st = useWorkspace.getState();
      const pid = st.activeProjectId;
      if (pid) st.openEditor(pid, `git-commit:${c.id}`, { kind: "commit" });
    },
  };

  const commitMenuFor = (e: React.MouseEvent, c: GitCommit) => {
    closeCard();
    const d = detailsCache.current.get(c.id);
    const url = commitWebUrl(typeof d === "object" ? d.remoteUrl : remoteUrl, c.id);
    const host = remoteToWeb(typeof d === "object" ? d.remoteUrl : remoteUrl)?.host;
    const items: MenuItem[] = [
      { label: "Open Changes", action: () => commitActions.openChanges(c) },
      ...(url && host ? [{ label: `Open on ${host}`, action: () => commitActions.openWeb(url) }] : []),
      "sep",
      { label: "Copy Commit Hash", action: () => commitActions.copy(c.id) },
      { label: "Copy Commit Message", action: () => commitActions.copy(typeof d === "object" ? `${d.summary}${d.body ? `\n\n${d.body}` : ""}` : c.summary) },
      "sep",
      { label: "Checkout (Detached)", disabled: !!busy, action: () => commitActions.checkout(c) },
      { label: "Create Branch Here…", disabled: !!busy, action: () => commitActions.createBranch(c) },
    ];
    menu.open(e, items);
  };

  const scopeMenu = (e: React.MouseEvent) =>
    menu.open(e, [
      { label: "Auto", hint: "current branch + upstream", checked: scope === "auto", action: () => setScope("auto") },
      { label: "All branches", checked: scope === "all", action: () => setScope("all") },
    ], { anchor: "below-start" });

  const files = gitStatus?.files ?? [];
  const staged = files.filter((f) => f.index !== " " && f.index !== "?");
  const changes = files.filter((f) => f.worktree !== " ");
  const local = branches.filter((b) => !b.isRemote);
  const remote = branches.filter((b) => b.isRemote);

  /** Run a git operation; refresh status/log afterwards. Returns success. */
  const run = async (label: string, op: GitOp, info?: string): Promise<boolean> => {
    setBusy(label);
    setOpError(null);
    setOpInfo(null);
    try {
      await api.gitOp(root, op);
      if (info) setOpInfo(info);
      return true;
    } catch (e) {
      setOpError(String(e));
      return false;
    } finally {
      setBusy(null);
      refreshGitForRoot(root);
      reloadRef.current();
    }
  };

  const discard = async (list: GitFileStatus[]) => {
    if (!list.length) return;
    const what = list.length === 1 ? baseName(relPath(list[0])) : `${list.length} files`;
    const untracked = list.filter((f) => f.worktree === "?").map(relPath);
    const tracked = list.filter((f) => f.worktree !== "?").map(relPath);
    const extra = untracked.length ? `\n\n${untracked.length} untracked file${untracked.length > 1 ? "s" : ""} will be deleted.` : "";
    if (!(await ask(`Discard changes in ${what}? This can't be undone.${extra}`, { title: "Discard changes", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" }))) return;
    await run("Discarding…", { op: "discard", tracked, untracked });
  };

  const rowActions: RowActions = {
    stage: (f) => void run("Staging…", { op: "stage", files: [relPath(f)] }),
    unstage: (f) => void run("Unstaging…", { op: "unstage", files: [relPath(f)] }),
    discard: (f) => void discard([f]),
    open: onOpenFile ? (f) => onOpenFile(`${root}/${relPath(f)}`) : undefined,
  };

  const commit = async (opts: { amend?: boolean; push?: boolean } = {}) => {
    const st = gitStatus;
    if (!st) return;
    const stagedNow = st.files.filter((f) => f.index !== " " && f.index !== "?");
    if (!opts.amend && !message.trim()) {
      setOpError("Enter a commit message.");
      return;
    }
    if (!stagedNow.length && !opts.amend) {
      if (!st.files.length) return;
      if (!(await ask("There are no staged changes. Stage all changes and commit them?", { title: "Commit", okLabel: "Stage All & Commit", cancelLabel: "Cancel" }))) return;
      if (!(await run("Staging…", { op: "stageAll" }))) return;
    }
    if (!(await run(opts.amend ? "Amending…" : "Committing…", { op: "commit", message, amend: !!opts.amend }))) return;
    setMessage("");
    if (opts.push) await run("Pushing…", { op: "push" }, "Pushed.");
  };

  const branchMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [{ label: "Create New Branch…", checked: false, action: () => setNewBranch("") }, "sep"];
    for (const b of branches.filter((x) => !x.isRemote)) {
      items.push({ label: b.name, checked: b.isHead, action: () => !b.isHead && void run("Switching…", { op: "checkout", branch: b.name }) });
    }
    const remotes = branches.filter((x) => x.isRemote && !x.name.endsWith("/HEAD") && !branches.some((l) => !l.isRemote && x.name.endsWith(`/${l.name}`)));
    if (remotes.length) {
      items.push("sep");
      for (const b of remotes.slice(0, 15)) items.push({ label: b.name, checked: false, hint: "remote", action: () => void run("Switching…", { op: "checkout", branch: b.name }) });
    }
    items.push("sep", { label: "Stash All Changes", action: () => void run("Stashing…", { op: "stash" }, "Changes stashed.") });
    if (gitStatus?.stashCount) items.push({ label: `Pop Stash (${gitStatus.stashCount})`, action: () => void run("Applying stash…", { op: "stashPop" }) });
    menu.open(e, items);
  };

  const commitMenu = (e: React.MouseEvent) =>
    menu.open(e, [
      { label: "Commit", hint: "⌘↵", action: () => void commit() },
      ...(gitStatus?.hasRemote ? [{ label: "Commit & Push", hint: "⇧⌘↵", action: () => void commit({ push: true }) }] : []),
      { label: "Amend Last Commit", action: () => void commit({ amend: true }) },
    ]);

  if (gitStatus && !gitStatus.isRepo) {
    return <div className="sb-git"><div className="sb-empty">Not a git repository.</div></div>;
  }

  return (
    <div className="sb-git">
      <div className="sb-git-head">
        <button className="sb-branch-btn" title="Switch branch" onClick={branchMenu} disabled={!!busy}>
          <Icon name="branch" />
          <span className="sb-branch">{gitStatus?.branch ?? (gitStatus ? "(detached)" : "…")}</span>
          <Icon name="chevronDown" size={12} />
        </button>
        <span className="sb-spacer" />
        {gitStatus?.hasRemote && (
          <>
            <button className="sb-icon-btn" title="Fetch" aria-label="Fetch" disabled={!!busy} onClick={() => void run("Fetching…", { op: "fetch" }, "Fetched.")}>
              <Icon name="refresh" />
            </button>
            <button className="sb-sync-btn" title={gitStatus.upstream ? `Pull from ${gitStatus.upstream}` : "No upstream branch"} disabled={!!busy || !gitStatus.upstream} onClick={() => void run("Pulling…", { op: "pull" }, "Pulled.")}>
              <Icon name="arrowDown" size={14} />{gitStatus.behind > 0 && <span>{gitStatus.behind}</span>}
            </button>
            {gitStatus.upstream ? (
              <button className={`sb-sync-btn${gitStatus.ahead > 0 ? " sb-sync-hot" : ""}`} title={`Push to ${gitStatus.upstream}`} disabled={!!busy} onClick={() => void run("Pushing…", { op: "push" }, "Pushed.")}>
                <Icon name="arrowUp" size={14} />{gitStatus.ahead > 0 && <span>{gitStatus.ahead}</span>}
              </button>
            ) : (
              gitStatus.branch && (
                <button className="sb-sync-btn sb-sync-hot" title="Publish branch" disabled={!!busy} onClick={() => void run("Publishing…", { op: "push" }, "Branch published.")}>
                  <Icon name="arrowUp" size={14} /><span>Publish</span>
                </button>
              )
            )}
          </>
        )}
      </div>

      {newBranch !== null && (
        <div className="sb-git-form">
          <input
            autoFocus
            placeholder={newBranchFrom ? `New branch at ${newBranchFrom.shortId}` : "New branch name"}
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setNewBranch(null);
                setNewBranchFrom(null);
              }
              if (e.key === "Enter" && newBranch.trim()) {
                const name = newBranch.trim();
                const from = newBranchFrom?.id ?? null;
                setNewBranch(null);
                setNewBranchFrom(null);
                void run("Creating branch…", { op: "createBranch", name, from });
              }
            }}
            onBlur={() => {
              if (!newBranch.trim()) {
                setNewBranch(null);
                setNewBranchFrom(null);
              }
            }}
          />
        </div>
      )}

      <div className="sb-git-form">
        <textarea
          className="sb-commit-msg"
          placeholder={`Message (⌘↵ to commit on ${gitStatus?.branch ?? "HEAD"})`}
          value={message}
          rows={Math.min(6, Math.max(2, message.split("\n").length))}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              void commit({ push: e.shiftKey && !!gitStatus?.hasRemote });
            }
          }}
        />
        <div className="sb-commit-row">
          <button className="sb-commit-btn" disabled={!!busy || !files.length || !message.trim()} onClick={() => void commit()}>
            <Icon name="check" size={14} /> {busy ?? (staged.length || !files.length ? "Commit" : "Commit All")}
          </button>
          <button className="sb-commit-more" title="More commit actions" aria-label="More commit actions" disabled={!!busy} onClick={commitMenu}>
            <Icon name="chevronDown" size={14} />
          </button>
        </div>
      </div>

      {opError && (
        <div className="sb-git-banner sb-git-banner-error" title={opError}>
          <span>{opError}</span>
          <button className="sb-icon-btn" aria-label="Dismiss" onClick={() => setOpError(null)}><Icon name="close" size={14} /></button>
        </div>
      )}
      {opInfo && !opError && (
        <div className="sb-git-banner" onClick={() => setOpInfo(null)}>{opInfo}</div>
      )}

      <div className="sb-git-sections" onScroll={() => hoverOpen.current && closeCard()}>
        <Section
          id="changes"
          title="Changes"
          count={files.length}
          open={open.changes}
          onToggle={toggle}
          actions={onOpenDiff && files.length > 0 ? (
            <button className="sb-icon-btn" title="Open working tree diff" aria-label="Open working tree diff" onClick={() => onOpenDiff(null, false)}>
              <Icon name="diff" />
            </button>
          ) : undefined}
        >
          {files.length === 0 && <div className="sb-empty">No changes.</div>}
          {staged.length > 0 && (
            <>
              <div className="sb-subheader sb-change" onClick={() => onOpenDiff?.(null, true)} title="Open staged diff" role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpenDiff?.(null, true)}>
                Staged <span className="sb-count">{staged.length}</span>
                <span className="sb-spacer" />
                <span className="sb-row-actions">
                  <button className="sb-icon-btn" title="Unstage all" onClick={(e) => { e.stopPropagation(); void run("Unstaging…", { op: "unstageAll" }); }}><Icon name="minus" /></button>
                </span>
              </div>
              {staged.map((f) => <ChangeRow key={`s:${f.path}`} file={f} staged onOpenDiff={onOpenDiff} actions={rowActions} busy={!!busy} />)}
            </>
          )}
          {changes.length > 0 && (
            <>
              <div className="sb-subheader sb-change" onClick={() => onOpenDiff?.(null, false)} title="Open working tree diff" role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpenDiff?.(null, false)}>
                Changes <span className="sb-count">{changes.length}</span>
                <span className="sb-spacer" />
                <span className="sb-row-actions">
                  <button className="sb-icon-btn" title="Discard all changes" onClick={(e) => { e.stopPropagation(); void discard(changes); }}><Icon name="discard" /></button>
                  <button className="sb-icon-btn" title="Stage all" onClick={(e) => { e.stopPropagation(); void run("Staging…", { op: "stageAll" }); }}><Icon name="plus" /></button>
                </span>
              </div>
              {changes.map((f) => <ChangeRow key={`w:${f.path}`} file={f} staged={false} onOpenDiff={onOpenDiff} actions={rowActions} busy={!!busy} />)}
            </>
          )}
        </Section>

        <Section id="worktrees" title="Worktrees" count={worktrees.length} open={open.worktrees} onToggle={toggle}>
          {loaded && worktrees.length === 0 && <div className="sb-empty">No worktrees.</div>}
          {worktrees.map((w) => {
            const current = trimSlash(w.path) === root;
            return (
              <div key={w.path} className={`sb-row${current ? " sb-current" : ""}`} style={{ paddingLeft: 22 }} title={w.path}>
                <span className="sb-name">{w.name}{w.isMain && <span className="sb-desc"> (main)</span>}</span>
                <span className="sb-spacer" />
                {w.branch && <span className="sb-chip sb-chip-branch">{w.branch}</span>}
              </div>
            );
          })}
        </Section>

        <Section id="branches" title="Branches" count={local.length} open={open.branches} onToggle={toggle}>
          {loaded && local.length === 0 && <div className="sb-empty">No branches.</div>}
          {local.map((b) => (
            <div
              key={b.name}
              className={`sb-row${b.isHead ? " sb-current" : ""}`}
              style={{ paddingLeft: 22 }}
              title={`${b.name} @ ${b.target.slice(0, 7)}${b.upstream ? ` → ${b.upstream}` : ""}${b.isHead ? "" : "\nDouble-click to switch"}`}
              onDoubleClick={() => !b.isHead && !busy && void run("Switching…", { op: "checkout", branch: b.name })}
            >
              <span className="sb-head-mark">{b.isHead && <Icon name="check" size={12} />}</span>
              <span className="sb-name">{b.name}</span>
              {b.upstream && <span className="sb-desc">{b.upstream}</span>}
            </div>
          ))}
          {remote.length > 0 && (
            <>
              <div className="sb-subheader" role="button" tabIndex={0} aria-expanded={showRemotes} onClick={() => setShowRemotes((v) => !v)} onKeyDown={(e) => e.key === "Enter" && setShowRemotes((v) => !v)}>
                <Icon name="chevronRight" size={14} className={`sb-chevron${showRemotes ? " sb-open" : ""}`} />
                Remote <span className="sb-count">{remote.length}</span>
              </div>
              {showRemotes && remote.map((b) => (
                <div
                  key={b.name}
                  className="sb-row"
                  style={{ paddingLeft: 32 }}
                  title={`${b.name} @ ${b.target.slice(0, 7)}\nDouble-click to check out`}
                  onDoubleClick={() => !busy && void run("Switching…", { op: "checkout", branch: b.name })}
                >
                  <span className="sb-name">{b.name}</span>
                </div>
              ))}
            </>
          )}
        </Section>

        <Section
          id="graph"
          title="Graph"
          open={open.graph}
          onToggle={toggle}
          grow
          actions={open.graph ? (
            <>
              <span className="sb-graph-repo" title={gitStatus?.root ?? root}>{repoName}</span>
              <button className="sb-scope-btn" title="Branches shown in the graph" aria-label={`Branches: ${scope === "auto" ? "Auto" : "All branches"}`} onClick={scopeMenu}>
                <Icon name="branch" size={12} />
                <span>{scope === "auto" ? "Auto" : "All"}</span>
                <Icon name="chevronDown" size={12} />
              </button>
              <button className="sb-icon-btn" title="Go to current commit" aria-label="Go to current commit" disabled={!headId} onClick={goToCurrent}><Icon name="target" /></button>
              {gitStatus?.hasRemote && (
                <>
                  <button className="sb-icon-btn" title="Fetch" aria-label="Fetch" disabled={!!busy} onClick={() => void run("Fetching…", { op: "fetch" }, "Fetched.")}><Icon name="fetch" /></button>
                  <button className="sb-icon-btn" title={gitStatus.upstream ? `Pull from ${gitStatus.upstream}` : "No upstream branch"} aria-label="Pull" disabled={!!busy || !gitStatus.upstream} onClick={() => void run("Pulling…", { op: "pull" }, "Pulled.")}><Icon name="arrowDown" /></button>
                  <button className="sb-icon-btn" title={gitStatus.upstream ? `Push to ${gitStatus.upstream}` : "Publish branch"} aria-label="Push" disabled={!!busy || !gitStatus.branch} onClick={() => void run("Pushing…", { op: "push" }, "Pushed.")}><Icon name="arrowUp" /></button>
                </>
              )}
              <button className="sb-icon-btn" title="Refresh" aria-label="Refresh graph" onClick={() => { refreshGitForRoot(root); reloadRef.current(); }}><Icon name="refresh" /></button>
            </>
          ) : undefined}
        >
          <div className="sb-graph" ref={graphRef}>
            {syncCounts.total > 0 && (
              <div className="sb-sync-legend">
                {syncCounts.outgoing > 0 && <span className="sb-sync-outgoing"><i />{syncCounts.outgoing} to push</span>}
                {syncCounts.incoming > 0 && <span className="sb-sync-incoming"><i />{syncCounts.incoming} to pull</span>}
                {syncCounts.local > 0 && <span className="sb-sync-local"><i />{syncCounts.local} on unpushed branches</span>}
              </div>
            )}
            {error && <div className="sb-empty sb-error">{error}</div>}
            {!loaded && <div className="sb-empty">Loading…</div>}
            {loaded && !error && graph.length === 0 && <div className="sb-empty">No commits.</div>}
            {graph.map((row) => {
              const c = row.commit;
              const isHead = c.id === headId;
              const pills = c.refs.length ? refPills(c.refs, refCtx) : [];
              return (
                <div
                  key={c.id}
                  className={`sb-graph-row${isHead ? " sb-graph-head" : ""}${c.sync ? ` sb-sync-${c.sync}` : ""}${hover?.id === c.id ? " sb-hovered" : ""}`}
                  aria-label={`${c.summary}, ${c.author}, ${c.shortId}${c.sync ? `, ${SYNC_NOTE[c.sync]}` : ""}`}
                  onMouseEnter={(e) => enterRow(c.id, e.currentTarget)}
                  onMouseLeave={leaveCard}
                  onContextMenu={(e) => commitMenuFor(e, c)}
                  onDoubleClick={() => commitActions.openChanges(c)}
                >
                  <GraphCell row={row} lanes={graphLanes} sync={c.sync} head={isHead} />
                  <span className="sb-graph-summary">{shortSubject(c.summary)}</span>
                  {pills.length > 0 && <RefPills pills={pills} color={row.color} />}
                  {c.sync === "outgoing" && <span className="sb-sync-badge" title={SYNC_NOTE.outgoing}><Icon name="arrowUp" size={12} /></span>}
                  {c.sync === "incoming" && <span className="sb-sync-badge" title={SYNC_NOTE.incoming}><Icon name="arrowDown" size={12} /></span>}
                </div>
              );
            })}
          </div>
        </Section>
      </div>
      {hover && (() => {
        const row = graph.find((r) => r.commit.id === hover.id);
        if (!row) return null;
        const d = detailsCache.current.get(hover.id);
        return (
          <CommitCard
            commit={row.commit}
            color={row.color}
            anchor={hover.rect}
            details={typeof d === "object" ? d : undefined}
            error={typeof d === "string" && d ? d : undefined}
            pills={row.commit.refs.length ? refPills(row.commit.refs, refCtx) : []}
            remoteUrl={remoteUrl}
            actions={commitActions}
            onEnter={keepCard}
            onLeave={leaveCard}
            onClose={closeCard}
          />
        );
      })()}
      {menu.element}
    </div>
  );
}
