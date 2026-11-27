// Small building blocks shared by the Tasks sidebar view, the Source Control section and the board.
import { useWorkspace } from "../../store/workspace";
import { agentView, livePane, type AgentView } from "../../tasks/agent";
import type { Task } from "../../tasks/types";
import { ClaudeMark } from "../icons";

export { ClaudeMark };

export const TASK_DRAG = "text/tcon-task";

/** Linear-style column status glyphs. */
export function StatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const frac = status === "in-progress" ? 0.5 : status === "review" ? 0.75 : 0;
  return (
    <svg className={`tk-status-icon tk-st-${status}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      {status === "done" ? (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="var(--tk-on-status, var(--bg))" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={status === "inbox" ? "2 1.6" : undefined} />
          {frac > 0 && (
            <circle cx="7" cy="7" r={r / 2} fill="none" stroke="currentColor" strokeWidth={r} strokeDasharray={`${(c / 2) * frac} ${c}`} transform="rotate(-90 7 7)" />
          )}
        </>
      )}
    </svg>
  );
}

/** Signal-bar priority glyph (urgent = filled alert square). */
export function PriorityIcon({ priority, size = 14 }: { priority: string; size?: number }) {
  if (priority === "urgent") {
    return (
      <svg className="tk-prio tk-prio-urgent" width={size} height={size} viewBox="0 0 14 14" aria-label="Urgent">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <path d="M7 3.8v4M7 9.8v.4" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  const level = priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0;
  if (!level) {
    return (
      <svg className="tk-prio tk-prio-none" width={size} height={size} viewBox="0 0 14 14" aria-label="No priority">
        <path d="M2.5 7h2M6 7h2M9.5 7h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className={`tk-prio tk-prio-${priority}`} width={size} height={size} viewBox="0 0 14 14" aria-label={priority}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 3.7} y={9 - i * 3} width="2.6" height={3 + i * 3} rx="0.8" fill="currentColor" opacity={i < level ? 1 : 0.28} />
      ))}
    </svg>
  );
}

export function Spinner({ size = 11 }: { size?: number }) {
  return (
    <svg className="tk-spinner" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Live agent state of a task (file state + its pane's OSC status). */
export function useAgentView(task: Task): AgentView {
  const pane = useWorkspace((s) => (task.paneId ? s.statuses[task.paneId] : undefined));
  // Subscribe to pane existence too, so closing the terminal updates the chip.
  const alive = useWorkspace(() => !!livePane(task));
  return agentView(task, pane, alive);
}

export function AgentChip({ task, compact }: { task: Task; compact?: boolean }) {
  const v = useAgentView(task);
  if (v.kind === "none") return null;
  return (
    <span className={`tk-agent tk-agent-${v.kind}${compact ? " tk-agent-compact" : ""}`} title={v.title}>
      {v.kind === "working" || v.kind === "planning" ? <Spinner /> : <ClaudeMark size={10} />}
      {!compact && <span>{v.label}</span>}
    </span>
  );
}

/** Stable hue per label, from theme tokens. */
export function labelColor(label: string): string {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // No danger/warn hues: those mean state elsewhere on the board.
  const palette = ["var(--accent)", "var(--ok)", "var(--claude)", "var(--sync-in, var(--accent))", "var(--sync-local, var(--accent))"];
  return palette[h % palette.length];
}

export function Labels({ labels, max = 3 }: { labels: string[]; max?: number }) {
  if (!labels.length) return null;
  return (
    <span className="tk-labels">
      {labels.slice(0, max).map((l) => (
        <span key={l} className="tk-label" style={{ ["--tk-label" as string]: labelColor(l) }}>
          <i />
          {l}
        </span>
      ))}
      {labels.length > max && <span className="tk-label tk-label-more">+{labels.length - max}</span>}
    </span>
  );
}

/** Index to insert at when dropping over `el` (before/after by the pointer's vertical midpoint). */
export function dropIndexFor(e: React.DragEvent, el: Element, index: number): number {
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2 ? index + 1 : index;
}

export interface DragPayload { root: string; id: string; column: string; index: number }

export function readDrag(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(TASK_DRAG);
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}

/** Target index for move(): positions are measured before the card leaves its old slot. */
export function adjustedIndex(drag: DragPayload, column: string, index: number): number {
  return drag.column === column && drag.index < index ? index - 1 : index;
}

export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}
