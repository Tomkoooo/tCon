// "commit" editor tab: one commit's message, stats and patch against its first parent.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { GitCommitDetails } from "../../types";
import { lineClass } from "./EditorPane";
import { absoluteTime, avatarColor, initials, relativeTime } from "../sidebar/commitCard";
import { writeText } from "../workbench/clipboard";
import { Icon } from "../icons";
import "./editor.css";

const MAX_LINES = 20000;
export const COMMIT_PATH_PREFIX = "git-commit:";
export const commitIdOf = (path: string) => (path.startsWith(COMMIT_PATH_PREFIX) ? path.slice(COMMIT_PATH_PREFIX.length) : path);

export function CommitView({ root, path }: { root: string; path: string }) {
  const id = commitIdOf(path);
  const [details, setDetails] = useState<GitCommitDetails | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([api.gitCommitDetails(root, id), api.gitCommitDiff(root, id)])
      .then(([d, p]) => {
        if (!live) return;
        setDetails(d);
        setPatch(p);
      })
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [root, id]);

  const lines = useMemo(() => {
    if (patch === null) return [];
    const all = patch.split("\n");
    if (all.length && all[all.length - 1] === "") all.pop();
    return all;
  }, [patch]);
  const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;

  return (
    <div className="ed-root">
      <div className="ed-header">
        <Icon name="commit" size={14} />
        <span className="ed-crumb-last" style={{ fontFamily: "var(--font-mono)" }}>{id.slice(0, 7)}</span>
        <span className="ed-dim" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{details?.summary}</span>
        <span className="ed-spacer" />
        <button className="ed-btn" onClick={() => void writeText(id)} title={id}>Copy hash</button>
      </div>
      <div className="ed-body">
        {error && <div className="ed-message ed-message-error">{error}</div>}
        {!error && !details && <div className="ed-message">Loading…</div>}
        {details && (
          <div className="commit-view">
            <div className="commit-view-meta">
              <span className="sb-avatar" style={{ background: avatarColor(details.authorEmail || details.author) }} aria-hidden>{initials(details.author)}</span>
              <b>{details.author}</b>
              {details.authorEmail && <span className="ed-dim">{details.authorEmail}</span>}
              <span className="ed-dim">· {relativeTime(details.time)} ({absoluteTime(details.time)})</span>
            </div>
            <div className="commit-view-subject">{details.summary}</div>
            {details.body && <div className="commit-view-body">{details.body}</div>}
            <div className="ed-dim commit-view-stats">
              {details.filesChanged} file{details.filesChanged === 1 ? "" : "s"} changed, {details.insertions} insertion{details.insertions === 1 ? "" : "s"}(+), {details.deletions} deletion{details.deletions === 1 ? "" : "s"}(−)
              {details.parents.length > 1 && " · merge commit, diff against the first parent"}
            </div>
            {lines.length === 0 ? (
              <div className="ed-message">No file changes.</div>
            ) : (
              <div className="ed-diff">
                {shown.map((l, i) => (
                  <div key={i} className={`ed-diff-line ${lineClass(l)}`}>{l || " "}</div>
                ))}
                {lines.length > MAX_LINES && <div className="ed-diff-line ed-diff-meta">… {lines.length - MAX_LINES} more lines not shown</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
