import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../api";
import type { FsChangedEvent, GitBranch, GitCommit, GitFileStatus, GitStatus, GitWorktree } from "../../types";
import { computeGraph, GRAPH_COLORS } from "./graphLayout";
import type { GraphRow } from "./graphLayout";
import { baseName, decorFor, parentDir, trimSlash } from "./gitDecor";
import "./sidebar.css";
import { FileIcon } from "../FileIcon";

export interface GitPanelProps {
  root: string;
  gitStatus?: GitStatus | null;
  onOpenDiff?(file: string | null, staged: boolean): void;
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

const GraphCell = memo(function GraphCell({ row, lanes }: { row: GraphRow; lanes: number }) {
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
      {row.isMerge ? (
        <circle cx={x(row.lane)} cy={ROW_H / 2} r={3} fill="var(--bg-2)" stroke={col(row.color)} strokeWidth={1.5} />
      ) : (
        <circle cx={x(row.lane)} cy={ROW_H / 2} r={3.5} fill={col(row.color)} />
      )}
    </svg>
  );
});

function ChangeRow({ file, staged, onOpenDiff }: { file: GitFileStatus; staged: boolean; onOpenDiff?: GitPanelProps["onOpenDiff"] }) {
  const d = decorFor(staged ? { ...file, worktree: " " } : file.index === "?" ? file : { ...file, index: " " });
  const rel = trimSlash(file.path.includes(" -> ") ? file.path.split(" -> ")[1] : file.path);
  const dir = rel.includes("/") ? parentDir(rel) : "";
  return (
    <div
      className={`sb-row sb-git-${d.kind}`}
      style={{ paddingLeft: 22 }}
      title={`${file.path} — ${staged ? "staged" : "working tree"}`}
      onClick={() => onOpenDiff?.(rel, staged)}
    >
      <FileIcon name={baseName(rel)} />
      <span className="sb-name">{baseName(rel)}</span>
      {dir && <span className="sb-desc">{dir}</span>}
      <span className="sb-spacer" />
      <span className="sb-badge">{d.letter}</span>
    </div>
  );
}

export function GitPanel({ root: rawRoot, gitStatus, onOpenDiff }: GitPanelProps) {
  const root = trimSlash(rawRoot);
  const [open, setOpen] = useState<Record<SectionId, boolean>>({ changes: true, worktrees: false, branches: false, graph: true });
  const [showRemotes, setShowRemotes] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const toggle = useCallback((id: SectionId) => setOpen((o) => ({ ...o, [id]: !o[id] })), []);

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
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.isRemote).map((b) => b.name)), [branches]);

  const files = gitStatus?.files ?? [];
  const staged = files.filter((f) => f.index !== " " && f.index !== "?");
  const changes = files.filter((f) => f.worktree !== " ");
  const local = branches.filter((b) => !b.isRemote);
  const remote = branches.filter((b) => b.isRemote);

  if (gitStatus && !gitStatus.isRepo) {
    return <div className="sb-git"><div className="sb-empty">Not a git repository.</div></div>;
  }

  return (
    <div className="sb-git">
      <div className="sb-git-head">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <circle cx="4.5" cy="3.5" r="1.7" /><circle cx="4.5" cy="12.5" r="1.7" /><circle cx="11.5" cy="5.5" r="1.7" />
          <path d="M4.5 5.2v5.6M11.5 7.2c0 3-7 2-7 3.6" />
        </svg>
        <span className="sb-branch" title={gitStatus?.branch ?? undefined}>{gitStatus?.branch ?? (gitStatus ? "(detached)" : "…")}</span>
        {gitStatus && (gitStatus.ahead > 0 || gitStatus.behind > 0) && (
          <span className="sb-aheadbehind" title={`${gitStatus.ahead} ahead, ${gitStatus.behind} behind upstream`}>
            {gitStatus.ahead > 0 && `↑${gitStatus.ahead}`}{gitStatus.ahead > 0 && gitStatus.behind > 0 && " "}{gitStatus.behind > 0 && `↓${gitStatus.behind}`}
          </span>
        )}
        <span className="sb-spacer" />
        {gitStatus?.head && <span className="sb-sha" title={gitStatus.head}>{gitStatus.head.slice(0, 7)}</span>}
      </div>

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
              <div className="sb-subheader" onClick={() => onOpenDiff?.(null, true)} title="Open staged diff">
                Staged <span className="sb-count">{staged.length}</span>
              </div>
              {staged.map((f) => <ChangeRow key={`s:${f.path}`} file={f} staged onOpenDiff={onOpenDiff} />)}
            </>
          )}
          {changes.length > 0 && (
            <>
              <div className="sb-subheader" onClick={() => onOpenDiff?.(null, false)} title="Open working-tree diff">
                Changes <span className="sb-count">{changes.length}</span>
              </div>
              {changes.map((f) => <ChangeRow key={`w:${f.path}`} file={f} staged={false} onOpenDiff={onOpenDiff} />)}
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
              title={`${b.name} @ ${b.target.slice(0, 7)}${b.upstream ? ` → ${b.upstream}` : ""}`}
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
                <div key={b.name} className="sb-row" style={{ paddingLeft: 32 }} title={`${b.name} @ ${b.target.slice(0, 7)}`}>
                  <span className="sb-name">{b.name}</span>
                </div>
              ))}
            </>
          )}
        </Section>

        <Section id="graph" title="Graph" count={commits.length || undefined} open={open.graph} onToggle={toggle} grow>
          <div className="sb-graph">
            {error && <div className="sb-empty sb-error">{error}</div>}
            {!loaded && <div className="sb-empty">Loading…</div>}
            {loaded && !error && graph.length === 0 && <div className="sb-empty">No commits.</div>}
            {graph.map((row) => {
              const c = row.commit;
              const chips = parseRefs(c.refs, remoteNames);
              return (
                <div
                  key={c.id}
                  className="sb-graph-row"
                  title={`${c.shortId}  ${c.author}\n${new Date(c.time > 1e12 ? c.time : c.time * 1000).toLocaleString()}\n\n${c.summary}`}
                >
                  <GraphCell row={row} lanes={graphLanes} />
                  <span className="sb-graph-text">
                    {chips.map((ch, i) => (
                      <span key={i} className={`sb-chip sb-chip-${ch.kind}`}>{ch.label}</span>
                    ))}
                    <span className="sb-graph-summary">{c.summary}</span>
                  </span>
                  <span className="sb-graph-author">{c.author}</span>
                  <span className="sb-graph-time">{relTime(c.time)}</span>
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    </div>
  );
}
