import { useEffect, useRef } from "react";
import { terminals } from "../terminal/registry";
import { useWorkspace } from "../store/workspace";
import type { Pane, PaneStatus } from "../types";
import { StatusDot } from "./StatusDot";
import { ClaudeMark, Icon } from "./icons";

interface Props {
  projectId: string;
  pane: Pane;
  status?: PaneStatus;
  focused: boolean;
  /** show the per-pane header (only useful when a tab holds split terminals) */
  showHeader: boolean;
  accent: string;
  onContextMenu(e: React.MouseEvent): void;
}

export function TerminalPane({ projectId, pane, status, focused, showHeader, accent, onContextMenu }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const focusPane = useWorkspace((s) => s.focusPane);
  const closePane = useWorkspace((s) => s.closePane);
  const restartPane = useWorkspace((s) => s.restartPane);
  const addTerminal = useWorkspace((s) => s.addTerminal);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    terminals.attach(pane.id, el);
    return () => terminals.detach(pane.id);
  }, [pane.id]);

  useEffect(() => {
    if (focused) requestAnimationFrame(() => terminals.focus(pane.id));
  }, [focused, pane.id]);

  const showProgress = status?.state === "working" && status.progress != null;
  const msg = status && (status.state === "blocked" || status.state === "error") ? status.msg || status.kind : null;

  return (
    <div
      className={`pane${focused ? " focused" : ""}${status?.state === "blocked" ? " attn" : ""}`}
      data-pane-id={pane.id}
      style={{ ["--pane-accent" as string]: accent }}
      onMouseDown={() => focusPane(projectId, pane.id)}
      onContextMenu={onContextMenu}
    >
      {showHeader && (
      <div className="pane-header">
        <StatusDot status={status} />
        {pane.isClaude && <ClaudeMark size={11} />}
        <span className="pane-title" title={`${pane.title}\n${pane.cwd}`}>
          {status?.title || pane.title}
        </span>
        {msg && <span className="pane-msg" title={msg}>{msg}</span>}
        {showProgress && <span className="pane-progress">{status!.progress}%</span>}
        <button className="icon-btn" title="Split right (⌘D)" onClick={() => { focusPane(projectId, pane.id); addTerminal(projectId, { claude: false, split: "row" }); }}>
          <Icon name="splitRight" size={14} />
        </button>
        <button className="icon-btn" title="Split down (⇧⌘D)" onClick={() => { focusPane(projectId, pane.id); addTerminal(projectId, { claude: false, split: "column" }); }}>
          <Icon name="splitDown" size={14} />
        </button>
        <button className="icon-btn" title="Kill terminal (⌘W)" aria-label="Kill terminal" onClick={() => closePane(projectId, pane.id)}><Icon name="close" size={14} /></button>
      </div>
      )}
      <div className="term-container" ref={ref} />
      {pane.exited && (
        <div className="pane-exited">
          <span>Process exited{pane.exitCode != null ? ` (${pane.exitCode})` : ""}</span>
          <button className="btn small primary" onClick={() => restartPane(pane.id)}>Restart</button>
          <button className="btn small" onClick={() => closePane(projectId, pane.id)}>Close</button>
        </div>
      )}
    </div>
  );
}
