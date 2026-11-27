// Commit graph pieces: ref badges, the hover card and its formatting helpers (VS Code's Source Control graph).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GitCommit, GitCommitDetails } from "../../types";
import { Icon, type IconName } from "../icons";
import { graphColor } from "./graphLayout";
import { shortRef } from "./refText";
import { commitWebUrl, remoteToWeb } from "./gitWeb";

// ---------------------------------------------------------------- ref badges

export interface RefPill {
  kind: "current" | "branch" | "remote" | "cloud" | "tag" | "head";
  label: string;
  title: string;
}

export interface RefContext {
  localNames: Set<string>;
  remoteNames: Set<string>;
  /** local branch → its upstream ("origin/main") */
  upstreamOf: Map<string, string>;
  /** checked-out branch, null when detached */
  headBranch: string | null;
}

/** Badges for one commit: local branches (with a cloud badge when their upstream is here too), remote-only branches, tags. */
export function refPills(refs: string[], ctx: RefContext): RefPill[] {
  const set = new Set(refs);
  const used = new Set<string>();
  const out: RefPill[] = [];
  const locals = refs.filter((r) => ctx.localNames.has(r)).sort((a, b) => (a === ctx.headBranch ? -1 : b === ctx.headBranch ? 1 : 0));
  if (set.has("HEAD") && !ctx.headBranch) out.push({ kind: "head", label: "HEAD", title: "Detached HEAD" });
  for (const b of locals) {
    const current = b === ctx.headBranch;
    out.push({ kind: current ? "current" : "branch", label: b, title: current ? `${b} (checked out)` : b });
    const up = ctx.upstreamOf.get(b) ?? [...ctx.remoteNames].find((r) => r.endsWith(`/${b}`) && set.has(r));
    if (up && set.has(up)) {
      out.push({ kind: "cloud", label: "", title: `${up} is at this commit too` });
      used.add(up);
    }
  }
  for (const r of refs) {
    if (r === "HEAD" || ctx.localNames.has(r) || used.has(r) || r.endsWith("/HEAD")) continue;
    if (ctx.remoteNames.has(r)) out.push({ kind: "remote", label: r, title: r });
    else out.push({ kind: "tag", label: r, title: `Tag ${r}` });
  }
  return out;
}

const PILL_ICON: Record<RefPill["kind"], IconName> = {
  current: "target", branch: "branch", remote: "cloud", cloud: "cloud", tag: "tag", head: "target",
};

export function RefPills({ pills, color, max = 3, full }: { pills: RefPill[]; color: number; max?: number; full?: boolean }) {
  const shown = pills.slice(0, max);
  const rest = pills.length - shown.length;
  return (
    <span className="sb-refs" style={{ ["--lane" as string]: graphColor(color) }}>
      {shown.map((p, i) => (
        <span key={i} className={`sb-ref sb-ref-${p.kind}${p.label ? "" : " sb-ref-icon"}`} title={p.title}>
          <Icon name={PILL_ICON[p.kind]} size={12} />
          {p.label && <span className="sb-ref-label">{full ? p.label : shortRef(p.label)}</span>}
        </span>
      ))}
      {rest > 0 && <span className="sb-ref sb-ref-more" title={pills.slice(max).map((p) => p.title).join("\n")}>+{rest}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- formatting

const ms = (t: number) => (t > 1e12 ? t : t * 1000);

export function relativeTime(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms(t)) / 1000));
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return unit(h, "hour");
  const d = Math.round(h / 24);
  if (d < 7) return unit(d, "day");
  if (d < 30) return unit(Math.round(d / 7), "week");
  if (d < 365) return unit(Math.round(d / 30), "month");
  return unit(Math.round(d / 365), "year");
}

export const absoluteTime = (t: number) =>
  new Date(ms(t)).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Stable colour per author for the initial avatar. */
export function avatarColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return graphColor(Math.abs(h));
}

export const initials = (name: string) => (name.trim().match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();

// ---------------------------------------------------------------- hover card

export const SYNC_NOTE: Record<string, string> = {
  outgoing: "Not pushed yet",
  incoming: "On the remote, not pulled yet",
  local: "Only on an unpushed branch",
};

export interface CommitActions {
  openWeb(url: string): void;
  copy(text: string): void;
  checkout(c: GitCommit): void;
  createBranch(c: GitCommit): void;
  openChanges(c: GitCommit): void;
}

export function CommitCard({
  commit, color, anchor, details, error, pills, remoteUrl, actions, onEnter, onLeave, onClose,
}: {
  commit: GitCommit;
  color: number;
  /** the hovered row's rect */
  anchor: DOMRect;
  details?: GitCommitDetails;
  error?: string;
  pills: RefPill[];
  remoteUrl: string | null;
  actions: CommitActions;
  onEnter(): void;
  onLeave(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  useEffect(() => setCopied(false), [commit.id]);

  // Place next to the row (right side if it fits, otherwise below/above it), inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const M = 8;
    const W = window.innerWidth, H = window.innerHeight;
    let left: number, top: number;
    if (anchor.right + 6 + r.width <= W - M) {
      left = anchor.right + 6;
      top = anchor.top - 6;
    } else {
      left = anchor.left + 24;
      top = anchor.bottom + 2 + r.height <= H - M ? anchor.bottom + 2 : anchor.top - 2 - r.height;
    }
    el.style.left = `${Math.max(M, Math.min(left, W - r.width - M))}px`;
    el.style.top = `${Math.max(M, Math.min(top, H - r.height - M))}px`;
    el.style.visibility = "visible";
  }, [anchor, details, error, commit.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const author = details?.author ?? commit.author;
  const email = details?.authorEmail;
  const time = details?.time ?? commit.time;
  const web = remoteToWeb(details?.remoteUrl ?? remoteUrl);
  const webUrl = commitWebUrl(details?.remoteUrl ?? remoteUrl, commit.id);
  const message = details ? `${details.summary}${details.body ? `\n\n${details.body}` : ""}` : commit.summary;

  const copyHash = () => {
    actions.copy(commit.id);
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      ref={ref}
      className="sb-card"
      role="dialog"
      aria-label={`Commit ${commit.shortId}`}
      style={{ visibility: "hidden", ["--lane" as string]: graphColor(color) }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="sb-card-who">
        <span className="sb-avatar" style={{ background: avatarColor(email || author) }} aria-hidden>{initials(author)}</span>
        <span className="sb-card-author">
          <b>{author}</b>
          {email && <span className="sb-card-dim"> {email}</span>}
        </span>
      </div>
      <div className="sb-card-dim sb-card-when">
        {relativeTime(time)} <span title={new Date(time > 1e12 ? time : time * 1000).toISOString()}>({absoluteTime(time)})</span>
      </div>

      <div className="sb-card-msg">
        <div className="sb-card-subject">{details?.summary ?? commit.summary}</div>
        {details?.body && <div className="sb-card-body">{details.body}</div>}
        {!details && !error && <div className="sb-card-dim sb-card-loading">Loading details…</div>}
        {error && <div className="sb-card-dim">{error}</div>}
      </div>

      {(details || commit.sync) && (
        <div className="sb-card-stats">
          {details && (
            <span>
              {details.filesChanged} file{details.filesChanged === 1 ? "" : "s"} changed
              {details.insertions > 0 && <span className="sb-card-add">, {details.insertions} insertion{details.insertions === 1 ? "" : "s"}(+)</span>}
              {details.deletions > 0 && <span className="sb-card-del">, {details.deletions} deletion{details.deletions === 1 ? "" : "s"}(−)</span>}
            </span>
          )}
          {details && details.parents.length > 1 && <span className="sb-card-dim"> · merge of {details.parents.length} parents</span>}
          {commit.sync && <span className={`sb-card-sync sb-sync-${commit.sync}`}> · {SYNC_NOTE[commit.sync]}</span>}
        </div>
      )}

      {pills.length > 0 && (
        <div className="sb-card-refs"><RefPills pills={pills} color={color} max={8} full /></div>
      )}

      <div className="sb-card-hash">
        <Icon name="commit" size={14} />
        <code title={commit.id}>{commit.shortId}</code>
        <button className="sb-card-link" onClick={copyHash} title="Copy the full commit hash">
          {copied ? <><Icon name="check" size={12} /> Copied</> : <><Icon name="copy" size={12} /> Copy</>}
        </button>
      </div>

      <div className="sb-card-actions">
        {webUrl && web && (
          <button className="sb-card-link" onClick={() => actions.openWeb(webUrl)} title={webUrl}><Icon name="external" size={12} /> Open on {web.host}</button>
        )}
        <button className="sb-card-link" onClick={() => actions.openChanges(commit)}><Icon name="diff" size={12} /> Open changes</button>
        <button className="sb-card-link" onClick={() => actions.copy(message)}><Icon name="notes" size={12} /> Copy message</button>
        <button className="sb-card-link" onClick={() => actions.checkout(commit)}><Icon name="target" size={12} /> Checkout (detached)</button>
        <button className="sb-card-link" onClick={() => actions.createBranch(commit)}><Icon name="branch" size={12} /> Create branch here…</button>
      </div>
    </div>
  );
}
