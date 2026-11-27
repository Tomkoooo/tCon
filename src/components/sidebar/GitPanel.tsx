import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../api";
import type { FsChangedEvent, GitBranch, GitCommit, GitFileStatus, GitOp, GitStatus, GitWorktree } from "../../types";
import { refreshGitForRoot } from "../../store/gitRefresh";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { computeGraph, GRAPH_COLORS } from "./graphLayout";
import type { GraphRow } from "./graphLayout";
import { baseName, decorFor, parentDir, trimSlash } from "./gitDecor";
import "./sidebar.css";
import { FileIcon } from "../FileIcon";

export interface GitPanelProps {
  root: string;
  gitStatus?: GitStatus | null;
  onOpenDiff?(file: string | null, staged: boolean): void;
  onOpenFile?(path: string): void;
}

/* small inline icons for row/section actions */
const I = {
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  discard: <path d="M3 7h7a3 3 0 0 1 0 6H7M3 7l3-3M3 7l3 3" />,
  open: <><path d="M9 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5z" /><path d="M9 2.5v4h4" /></>,
  fetch: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" />,
  pull: <path d="M8 2.5v10M4 8.5l4 4 4-4" />,
  push: <path d="M8 13.5v-10M4 7.5l4-4 4 4" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  chevron: <path d="M4 6l4 4 4-4" />,
  branch: <><circle cx="4.5" cy="3.5" r="1.7" /><circle cx="4.5" cy="12.5" r="1.7" /><circle cx="11.5" cy="5.5" r="1.7" /><path d="M4.5 5.2v5.6M11.5 7.2c0 3-7 2-7 3.6" /></>,
};
const Icon = ({ i, size = 14 }: { i: keyof typeof I; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{I[i]}</svg>
);

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
      <div className="sb-section-header" onClick={() => props.onToggle(props.id)}>
        <svg width="10" height="10" viewBox="0 0 10 10" className={`sb-chevron${props.open ? " sb-open" : ""}`}>
          <path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span className="sb-section-title">{props.title}</span>
        {props.count !== undefined && <span className="sb-count">{props.count}</span>}
        <span className="sb-spacer" />
        {props.actions && <span className="sb-section-actions" onClick={(e) => e.stopPropagation()}>{props.actions}</span>}
      </div>
      {props.open && <div className="sb-section-body">{props.children}</div>}
    </div>
  );
}

function relTime(t: number): string {
  const ms = t > 1e12 ? t : t * 1000;
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

interface RefChip { label: string; kind: "head" | "branch" | "remote" | "tag" }

function parseRefs(refs: string[], remoteNames: Set<string>): RefChip[] {
  const out: RefChip[] = [];
  for (const raw of refs) {
    let r = raw.trim();
    if (!r) continue;
    if (r.startsWith("HEAD -> ")) {
      out.push({ label: "HEAD", kind: "head" });
      r = r.slice(8);
    }
    if (r === "HEAD") { out.push({ label: "HEAD", kind: "head" }); continue; }
    if (r.startsWith("tag: ")) { out.push({ label: r.slice(5).replace(/^refs\/tags\//, ""), kind: "tag" }); continue; }
    if (r.startsWith("refs/tags/")) { out.push({ label: r.slice(10), kind: "tag" }); continue; }
    if (r.startsWith("refs/remotes/")) { out.push({ label: r.slice(13), kind: "remote" }); continue; }
    if (r.startsWith("refs/heads/")) { out.push({ label: r.slice(11), kind: "branch" }); continue; }
    if (r.endsWith("/HEAD")) continue;
    out.push({ label: r, kind: remoteNames.has(r) ? "remote" : "branch" });
  }
  return out;
}

const SYNC_COLOR: Record<string, string> = { outgoing: "var(--sync-out)", incoming: "var(--sync-in)", local: "var(--sync-local)" };
const SYNC_TITLE: Record<string, string> = {
  outgoing: "Local commit — not pushed yet",
  incoming: "Incoming — on the remote, not pulled yet",
  local: "Local only — on an unpublished/unpushed branch",
};

const GraphCell = memo(function GraphCell({ row, lanes, sync }: { row: GraphRow; lanes: number; sync?: string | null }) {
  const w = lanes * LANE_W + 4;
  const x = (lane: number) => lane * LANE_W + LANE_W / 2 + 2;
  const y = (f: number) => f * ROW_H;
  const col = (c: number) => GRAPH_COLORS[c % GRAPH_COLORS.length];
  return (
    <svg className="sb-graph-svg" width={w} height={ROW_H} viewBox={`0 0 ${w} ${ROW_H}`}>
      {row.segments.map((s, i) => {
        if (s.x1 === s.x2) {
          return <line key={i} x1={x(s.x1)} y1={y(s.y1)} x2={x(s.x2)} y2={y(s.y2)} stroke={col(s.color)} strokeWidth={1.5} />;
        }
        const ym = (y(s.y1) + y(s.y2)) / 2;
        const d = `M${x(s.x1)} ${y(s.y1)} C${x(s.x1)} ${ym} ${x(s.x2)} ${ym} ${x(s.x2)} ${y(s.y2)}`;
        return <path key={i} d={d} fill="none" stroke={col(s.color)} strokeWidth={1.5} />;
      })}
      {sync === "incoming" ? (
        // incoming: hollow dashed node, like a "ghost" commit you don't have yet
        <circle cx={x(row.lane)} cy={ROW_H / 2} r={3.5} fill="var(--bg-2)" stroke={SYNC_COLOR.incoming} strokeWidth={1.5} strokeDasharray="2 1.5" />
      ) : sync ? (
        <circle cx={x(row.lane)} cy={ROW_H / 2} r={4} fill={SYNC_COLOR[sync]} stroke="var(--bg-2)" strokeWidth={1} />
      ) : row.isMerge ? (
        <circle cx={x(row.lane)} cy={ROW_H / 2} r={3} fill="var(--bg-2)" stroke={col(row.color)} strokeWidth={1.5} />
      ) : (
        <circle cx={x(row.lane)} cy={ROW_H / 2} r={3.5} fill={col(row.color)} />
      )}
    </svg>
  );
});

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
          <button className="sb-icon-btn" title="Open file" onClick={stop(() => actions.open!(file))}><Icon i="open" /></button>
        )}
        {!staged && (
          <button className="sb-icon-btn" title="Discard changes" onClick={stop(() => actions.discard(file))}><Icon i="discard" /></button>
        )}
        {staged ? (
          <button className="sb-icon-btn" title="Unstage" onClick={stop(() => actions.unstage(file))}><Icon i="minus" /></button>
        ) : (
          <button className="sb-icon-btn" title="Stage" onClick={stop(() => actions.stage(file))}><Icon i="plus" /></button>
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
  const menu = useContextMenu();
  const reloadRef = useRef<() => void>(() => {});

  const reload = useCallback(async (isCancelled: () => boolean) => {
    const [log, br, wt] = await Promise.allSettled([
      api.gitLog(root, LOG_LIMIT),
      api.gitBranches(root),
      api.gitWorktrees(root),
    ]);
    if (isCancelled()) return;
    setCommits(log.status === "fulfilled" ? log.value : []);
    setBranches(br.status === "fulfilled" ? br.value : []);
    setWorktrees(wt.status === "fulfilled" ? wt.value : []);
    setError(log.status === "rejected" ? String(log.reason) : null);
    setLoaded(true);
  }, [root]);

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
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.isRemote).map((b) => b.name)), [branches]);

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
    const items: MenuItem[] = [{ label: "Create New Branch…", action: () => setNewBranch("") }, "sep"];
    for (const b of branches.filter((x) => !x.isRemote)) {
      items.push({ label: `${b.isHead ? "✓" : "\u2003"} ${b.name}`, action: () => !b.isHead && void run("Switching…", { op: "checkout", branch: b.name }) });
    }
    const remotes = branches.filter((x) => x.isRemote && !x.name.endsWith("/HEAD") && !branches.some((l) => !l.isRemote && x.name.endsWith(`/${l.name}`)));
    if (remotes.length) {
      items.push("sep");
      for (const b of remotes.slice(0, 15)) items.push({ label: `\u2003 ${b.name}`, hint: "remote", action: () => void run("Switching…", { op: "checkout", branch: b.name }) });
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
          <Icon i="branch" />
          <span className="sb-branch">{gitStatus?.branch ?? (gitStatus ? "(detached)" : "…")}</span>
          <Icon i="chevron" size={10} />
        </button>
        <span className="sb-spacer" />
        {gitStatus?.hasRemote && (
          <>
            <button className="sb-icon-btn" title="Fetch" disabled={!!busy} onClick={() => void run("Fetching…", { op: "fetch" }, "Fetched.")}>
              <Icon i="fetch" />
            </button>
            <button className="sb-sync-btn" title={gitStatus.upstream ? `Pull from ${gitStatus.upstream}` : "No upstream branch"} disabled={!!busy || !gitStatus.upstream} onClick={() => void run("Pulling…", { op: "pull" }, "Pulled.")}>
              <Icon i="pull" />{gitStatus.behind > 0 && <span>{gitStatus.behind}</span>}
            </button>
            {gitStatus.upstream ? (
              <button className={`sb-sync-btn${gitStatus.ahead > 0 ? " sb-sync-hot" : ""}`} title={`Push to ${gitStatus.upstream}`} disabled={!!busy} onClick={() => void run("Pushing…", { op: "push" }, "Pushed.")}>
                <Icon i="push" />{gitStatus.ahead > 0 && <span>{gitStatus.ahead}</span>}
              </button>
            ) : (
              gitStatus.branch && (
                <button className="sb-sync-btn sb-sync-hot" title="Publish this branch to the remote" disabled={!!busy} onClick={() => void run("Publishing…", { op: "push" }, "Branch published.")}>
                  <Icon i="push" /><span>Publish</span>
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
            placeholder="New branch name"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNewBranch(null);
              if (e.key === "Enter" && newBranch.trim()) {
                const name = newBranch.trim();
                setNewBranch(null);
                void run("Creating branch…", { op: "createBranch", name });
              }
            }}
            onBlur={() => !newBranch.trim() && setNewBranch(null)}
          />
        </div>
      )}

      <div className="sb-git-form">
        <textarea
          className="sb-commit-msg"
          placeholder={`Message (⌘↵ to commit on "${gitStatus?.branch ?? "HEAD"}")`}
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
            <Icon i="check" /> {busy ?? (staged.length || !files.length ? "Commit" : "Commit All")}
          </button>
          <button className="sb-commit-more" title="More commit actions" disabled={!!busy} onClick={commitMenu}>
            <Icon i="chevron" size={12} />
          </button>
        </div>
      </div>

      {opError && (
        <div className="sb-git-banner sb-git-banner-error" title={opError}>
          <span>{opError}</span>
          <button className="sb-icon-btn" onClick={() => setOpError(null)}>×</button>
        </div>
      )}
      {opInfo && !opError && (
        <div className="sb-git-banner" onClick={() => setOpInfo(null)}>{opInfo}</div>
      )}

      <div className="sb-git-sections">
        <Section
          id="changes"
          title="Changes"
          count={files.length}
          open={open.changes}
          onToggle={toggle}
          actions={onOpenDiff && files.length > 0 ? (
            <button className="sb-icon-btn" title="Open full working-tree diff" onClick={() => onOpenDiff(null, false)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M8 2v6M5 5h6M5 12h6" />
              </svg>
            </button>
          ) : undefined}
        >
          {files.length === 0 && <div className="sb-empty">No changes.</div>}
          {staged.length > 0 && (
            <>
              <div className="sb-subheader sb-change" onClick={() => onOpenDiff?.(null, true)} title="Open staged diff">
                Staged <span className="sb-count">{staged.length}</span>
                <span className="sb-spacer" />
                <span className="sb-row-actions">
                  <button className="sb-icon-btn" title="Unstage all" onClick={(e) => { e.stopPropagation(); void run("Unstaging…", { op: "unstageAll" }); }}><Icon i="minus" /></button>
                </span>
              </div>
              {staged.map((f) => <ChangeRow key={`s:${f.path}`} file={f} staged onOpenDiff={onOpenDiff} actions={rowActions} busy={!!busy} />)}
            </>
          )}
          {changes.length > 0 && (
            <>
              <div className="sb-subheader sb-change" onClick={() => onOpenDiff?.(null, false)} title="Open working-tree diff">
                Changes <span className="sb-count">{changes.length}</span>
                <span className="sb-spacer" />
                <span className="sb-row-actions">
                  <button className="sb-icon-btn" title="Discard all changes" onClick={(e) => { e.stopPropagation(); void discard(changes); }}><Icon i="discard" /></button>
                  <button className="sb-icon-btn" title="Stage all" onClick={(e) => { e.stopPropagation(); void run("Staging…", { op: "stageAll" }); }}><Icon i="plus" /></button>
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
              <span className="sb-head-mark">{b.isHead ? "●" : ""}</span>
              <span className="sb-name">{b.name}</span>
              {b.upstream && <span className="sb-desc">{b.upstream}</span>}
            </div>
          ))}
          {remote.length > 0 && (
            <>
              <div className="sb-subheader" onClick={() => setShowRemotes((v) => !v)}>
                <svg width="10" height="10" viewBox="0 0 10 10" className={`sb-chevron${showRemotes ? " sb-open" : ""}`}>
                  <path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
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

        <Section id="graph" title="Graph" count={commits.length || undefined} open={open.graph} onToggle={toggle} grow>
          <div className="sb-graph">
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
              const chips = parseRefs(c.refs, remoteNames);
              return (
                <div
                  key={c.id}
                  className={`sb-graph-row${c.sync ? ` sb-sync-${c.sync}` : ""}`}
                  title={`${c.shortId}  ${c.author}\n${new Date(c.time > 1e12 ? c.time : c.time * 1000).toLocaleString()}${c.sync ? `\n${SYNC_TITLE[c.sync]}` : ""}\n\n${c.summary}`}
                >
                  <GraphCell row={row} lanes={graphLanes} sync={c.sync} />
                  <span className="sb-graph-text">
                    {chips.map((ch, i) => (
                      <span key={i} className={`sb-chip sb-chip-${ch.kind}`}>{ch.label}</span>
                    ))}
                    <span className="sb-graph-summary">{c.summary}</span>
                  </span>
                  {c.sync === "outgoing" && <span className="sb-sync-badge" title={SYNC_TITLE.outgoing}>↑</span>}
                  {c.sync === "incoming" && <span className="sb-sync-badge" title={SYNC_TITLE.incoming}>↓</span>}
                  <span className="sb-graph-author">{c.author}</span>
                  <span className="sb-graph-time">{relTime(c.time)}</span>
                </div>
              );
            })}
          </div>
        </Section>
      </div>
      {menu.element}
    </div>
  );
}
