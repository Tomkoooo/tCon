// Card detail drawer: edit title / description / status / priority / labels, follow the agent's
// plan, progress log and verification, and run the agent actions.
import { useEffect, useRef, useState } from "react";
import { useTasks } from "../../tasks/store";
import { livePane, openAgentTerminal, projectForRoot, startAgent, stopAgent } from "../../tasks/agent";
import { PRIORITIES, type BoardState, type Task } from "../../tasks/types";
import { useWorkspace } from "../../store/workspace";
import { confirmDelete } from "./TasksView";
import { AgentChip, ClaudeMark, PriorityIcon, StatusIcon, labelColor, relTime, useAgentView } from "./parts";
import { Icon } from "../icons";

interface Section { heading: string; body: string }

function splitSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of md.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      cur = { heading: m[1], body: "" };
      out.push(cur);
    } else if (cur) cur.body += (cur.body ? "\n" : "") + line;
  }
  return out.map((s) => ({ ...s, body: s.body.trim() }));
}

/** Tiny Markdown renderer for agent notes: bullets, numbered lists, code fences, paragraphs. */
function MiniMarkdown({ text, log }: { text: string; log?: boolean }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key++} className="tkd-code">{code.join("\n")}</pre>);
      continue;
    }
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d/.test(line);
      while (i < lines.length && bullet.test(lines[i])) items.push(lines[i++].replace(bullet, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++} className={log ? "tkd-log" : "tkd-list"}>
          {items.map((it, j) => {
            const m = log ? /^(\d{4}-\d\d-\d\d \d\d:\d\d)\s+[—–-]\s+(.*)$/.exec(it) : null;
            return m ? (
              <li key={j} className={/^(blocked|failed)/i.test(m[2]) ? "warn" : /^done/i.test(m[2]) ? "ok" : ""}>
                <time>{m[1].slice(5)}</time>
                <span>{m[2]}</span>
              </li>
            ) : (
              <li key={j}>{it}</li>
            );
          })}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !bullet.test(lines[i]) && !lines[i].startsWith("```")) para.push(lines[i++]);
    blocks.push(<p key={key++}>{para.join(" ")}</p>);
  }
  return <>{blocks}</>;
}

export function TaskDrawer({ root, task, state, onClose }: { root: string; task: Task; state: BoardState; onClose(): void }) {
  const st = useTasks.getState();
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description);
  const [labelDraft, setLabelDraft] = useState("");
  const titleDirty = useRef(false);
  const descDirty = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const view = useAgentView(task);
  const alive = useWorkspace(() => !!livePane(task));

  // Follow external edits (Claude, another view) unless the user is editing that field.
  useEffect(() => {
    if (!titleDirty.current) setTitle(task.title);
  }, [task.title]);
  useEffect(() => {
    if (!descDirty.current) setDesc(task.description);
  }, [task.description]);

  const saveTitle = () => {
    titleDirty.current = false;
    const t = title.trim();
    if (t && t !== task.title) void st.update(root, task.id, { title: t });
    else setTitle(task.title);
  };
  const saveDesc = () => {
    descDirty.current = false;
    if (desc.trim() !== task.description.trim()) void st.update(root, task.id, { description: desc });
  };
  const closeAll = () => {
    if (titleDirty.current) saveTitle();
    if (descDirty.current) saveDesc();
    onClose();
  };

  // Autosave the description shortly after typing stops.
  useEffect(() => {
    if (!descDirty.current) return;
    const t = window.setTimeout(saveDesc, 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desc]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const addLabel = () => {
    const parts = labelDraft.split(",").map((s) => s.trim()).filter(Boolean);
    setLabelDraft("");
    if (!parts.length) return;
    const labels = [...task.labels];
    for (const p of parts) if (!labels.includes(p)) labels.push(p);
    void st.update(root, task.id, { labels });
  };

  const sections = splitSections(task.sections);
  const project = projectForRoot(root);
  const running = (task.agent === "running" || task.agent === "blocked") && alive;
  const queued = task.agent === "queued";

  return (
    <div className="tkd-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeAll()}>
      <div
        className="tkd"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeAll();
          }
          e.stopPropagation(); // board shortcuts don't apply inside the drawer
        }}
      >
        <div className="tkd-head">
          <StatusIcon status={task.status} />
          <span className="tkd-id">{task.id}</span>
          <span className="tkd-updated" title={task.updated}>Updated {relTime(task.updated || task.created)}</span>
          <span className="sb-spacer" />
          {project && (
            <button
              className="sb-icon-btn"
              title={`Open .tcon/tasks/${task.id}.md`}
              aria-label={`Open .tcon/tasks/${task.id}.md`}
              onClick={() => useWorkspace.getState().openEditor(project.id, `${project.rootPath}/.tcon/tasks/${task.id}.md`)}
            >
              <Icon name="file" />
            </button>
          )}
          <button className="sb-icon-btn" title="Close (Esc)" aria-label="Close" onClick={closeAll}>
            <Icon name="close" />
          </button>
        </div>

        <div className="tkd-scroll">
          <textarea
            className="tkd-title"
            rows={1}
            value={title}
            placeholder="Task title"
            onChange={(e) => {
              titleDirty.current = true;
              setTitle(e.target.value.replace(/\n/g, " "));
            }}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
          />

          <div className="tkd-props">
            <span className="tkd-prop-label">Status</span>
            <span className="tkd-prop">
              <StatusIcon status={task.status} size={12} />
              <select value={task.status} onChange={(e) => void st.move(root, task.id, e.target.value, Number.MAX_SAFE_INTEGER)}>
                {state.board.columns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </span>

            <span className="tkd-prop-label">Priority</span>
            <span className="tkd-prop">
              <PriorityIcon priority={task.priority} size={12} />
              <select value={task.priority} onChange={(e) => void st.update(root, task.id, { priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                {!PRIORITIES.some((p) => p.id === task.priority) && <option value={task.priority}>{task.priority}</option>}
              </select>
            </span>

            <span className="tkd-prop-label">Labels</span>
            <span className="tkd-prop tkd-labels">
              {task.labels.map((l) => (
                <span key={l} className="tk-label tk-label-edit" style={{ ["--tk-label" as string]: labelColor(l) }}>
                  <i />
                  {l}
                  <button title={`Remove ${l}`} aria-label={`Remove ${l}`} onClick={() => void st.update(root, task.id, { labels: task.labels.filter((x) => x !== l) })}><Icon name="close" size={12} /></button>
                </span>
              ))}
              <input
                className="tkd-label-input"
                placeholder={task.labels.length ? "Add" : "Add label"}
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={addLabel}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addLabel();
                  } else if (e.key === "Backspace" && !labelDraft && task.labels.length) {
                    void st.update(root, task.id, { labels: task.labels.slice(0, -1) });
                  }
                }}
              />
            </span>

            <span className="tkd-prop-label">Agent</span>
            <span className="tkd-prop">
              {view.kind === "none" ? <span className="tkd-dim">{task.agent === "idle" || !task.agent ? "Not started" : task.agent}</span> : <AgentChip task={task} />}
            </span>

            {(task.branch || task.commits.length > 0) && (
              <>
                <span className="tkd-prop-label">Git</span>
                <span className="tkd-prop tkd-git">
                  {task.branch && <span className="tkd-branch">{task.branch}</span>}
                  {task.commits.map((c) => <code key={c}>{c.slice(0, 8)}</code>)}
                </span>
              </>
            )}
          </div>

          <div className="tkd-actions">
            {running || queued ? (
              <button className="btn small" onClick={() => void stopAgent(root, task.id)}>
                <Icon name="stop" size={14} />
                {queued ? "Remove from queue" : "Stop agent"}
              </button>
            ) : (
              <button className="btn small" disabled={!project} title={project ? undefined : "Open this folder as a project first"} onClick={() => void startAgent(root, task.id)}>
                <ClaudeMark size={12} />
                {task.agent === "done" || task.agent === "failed" ? "Run Claude again" : "Start Claude"}
              </button>
            )}
            <button className="btn small" disabled={!alive} title={alive ? undefined : "No agent terminal is open"} onClick={() => openAgentTerminal(root, task.id)}>
              <Icon name="terminal" size={14} />
              Agent terminal
            </button>
            <span className="sb-spacer" />
            <button className="btn small ghost danger" onClick={() => void confirmDelete(root, task)}>Delete</button>
          </div>

          <div className="tkd-section">
            <div className="tkd-section-title">Description</div>
            <textarea
              className="tkd-desc"
              value={desc}
              placeholder="Add a description (Markdown)"
              onChange={(e) => {
                descDirty.current = true;
                setDesc(e.target.value);
              }}
              onBlur={saveDesc}
            />
          </div>

          {sections.map((s) => (
            <div key={s.heading} className="tkd-section">
              <div className="tkd-section-title">{s.heading}</div>
              {s.body ? (
                <div className="tkd-md">
                  <MiniMarkdown text={s.body} log={/progress log/i.test(s.heading)} />
                </div>
              ) : (
                <div className="tkd-dim tkd-placeholder">
                  {/plan/i.test(s.heading) ? "Claude adds its plan here." : /verification/i.test(s.heading) ? "Test and build results appear here." : "Empty"}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
