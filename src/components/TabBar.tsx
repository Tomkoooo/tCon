import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { INACTIVE_AFTER_MS, PALETTE, projectStatus, useWorkspace } from "../store/workspace";
import type { Project } from "../types";
import { StatusDot, statusLabel } from "./StatusDot";
import { useContextMenu } from "./ContextMenu";
import { AccountChip } from "./AccountChip";
import { confirmProjectEditors } from "./editor/editorActions";

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function TabBar() {
  const order = useWorkspace((s) => s.order);
  const projects = useWorkspace((s) => s.projects);
  const statuses = useWorkspace((s) => s.statuses);
  const activeProjectId = useWorkspace((s) => s.activeProjectId);
  const showInactive = useWorkspace((s) => s.showInactive);
  const setShowInactive = useWorkspace((s) => s.setShowInactive);
  const setModal = useWorkspace((s) => s.setModal);
  const now = useNow(60_000);

  const isInactive = (p: Project) => {
    if (p.id === activeProjectId) return false;
    const st = projectStatus(p, statuses);
    if (st && (st.state === "working" || st.state === "blocked" || (st.state === "done" && !st.seen))) return false;
    return now - p.lastInteracted > INACTIVE_AFTER_MS;
  };

  const active = order.filter((id) => projects[id] && !isInactive(projects[id]));
  const inactive = order.filter((id) => projects[id] && isInactive(projects[id]));

  return (
    <div className="tabbar" data-tauri-drag-region>
      <div className="tabbar-scroll" data-tauri-drag-region>
        {active.map((id) => (
          <Tab key={id} project={projects[id]} index={order.indexOf(id)} />
        ))}
        {inactive.length > 0 && (
          <button className="tab-section" onClick={() => setShowInactive(!showInactive)} title="Projects idle for 30+ minutes">
            {showInactive ? "▾" : "▸"} Inactive ({inactive.length})
          </button>
        )}
        {showInactive && inactive.map((id) => <Tab key={id} project={projects[id]} index={order.indexOf(id)} />)}
        <button className="icon-btn" title="New project tab (⌘T)" onClick={() => setModal({ kind: "newProject" })} style={{ alignSelf: "center" }}>
          +
        </button>
        <div className="drag-region" data-tauri-drag-region style={{ flex: 1 }} />
      </div>
      <div className="tabbar-actions">
        <AccountChip />
        <button className="icon-btn" title="Settings (⌘,)" onClick={() => setModal({ kind: "profiles" })}>⚙</button>
      </div>
    </div>
  );
}

function Tab({ project, index }: { project: Project; index: number }) {
  const statuses = useWorkspace((s) => s.statuses);
  const activeProjectId = useWorkspace((s) => s.activeProjectId);
  const git = useWorkspace((s) => s.gitStatus[project.id]);
  const profiles = useWorkspace((s) => s.profiles);
  const st = useWorkspace.getState();
  const menu = useContextMenu();
  const [editing, setEditing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const status = projectStatus(project, statuses);
  const profile = profiles.find((p) => p.id === project.profileId);
  const badge = project.accountLabel || profile?.name;
  const paneCount = Object.keys(project.panes).length;
  const attention = Object.keys(project.panes).filter((id) => statuses[id]?.state === "blocked").length;

  const title = [
    project.rootPath,
    git?.branch ? `branch: ${git.branch}${git.dirty ? " (dirty)" : ""}` : null,
    badge ? `account: ${badge}` : null,
    status ? `status: ${statusLabel(status)}` : null,
    `${paneCount} pane${paneCount === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join("\n");

  const onContextMenu = (e: React.MouseEvent) =>
    menu.open(e, [
      { label: "Rename…", action: () => setEditing(true) },
      {
        custom: (
          <div className="ctx-swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`swatch${c === project.color ? " selected" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  st.updateProject(project.id, { color: c });
                  menu.close();
                }}
              />
            ))}
          </div>
        ),
      },
      { label: "Project Settings…", action: () => st.setModal({ kind: "projectSettings", projectId: project.id }) },
      "sep",
      { label: "New Claude Terminal", hint: "⇧⌘C", action: () => st.addTerminal(project.id, { claude: true }) },
      { label: "New Terminal", hint: "⇧⌘T", action: () => st.addTerminal(project.id, { claude: false }) },
      { label: project.sidebarOpen ? "Hide Sidebar" : "Show Sidebar", hint: "⌘B", action: () => st.updateProject(project.id, { sidebarOpen: !project.sidebarOpen }) },
      "sep",
      { label: "Close Project", action: () => void closeWithConfirm(project) },
    ]);

  return (
    <>
      <div
        className={`tab${project.id === activeProjectId ? " active" : ""}`}
        style={{ ["--tab-color" as string]: project.color, outline: dragOver ? "1px dashed var(--accent)" : undefined }}
        title={title}
        draggable={!editing}
        onDragStart={(e) => e.dataTransfer.setData("text/tcon-project", project.id)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("text/tcon-project")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const id = e.dataTransfer.getData("text/tcon-project");
          if (id && id !== project.id) st.moveProject(id, index);
        }}
        onMouseDown={(e) => e.button === 0 && st.setActive(project.id)}
        onDoubleClick={() => setEditing(true)}
        onContextMenu={onContextMenu}
        onAuxClick={(e) => e.button === 1 && void closeWithConfirm(project)}
      >
        <StatusDot status={status} />
        {editing ? (
          <input
            autoFocus
            defaultValue={project.name}
            style={{ padding: "1px 4px", width: 120 }}
            onBlur={(e) => {
              st.updateProject(project.id, { name: e.target.value.trim() || project.name });
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="tab-name">{project.name}</span>
        )}
        {attention > 1 && <span className="tab-count">{attention}!</span>}
        {paneCount > 1 && <span className="tab-count">{paneCount}</span>}
        {git?.dirty && <span className="tab-dirty" title="Uncommitted changes" />}
        {badge && (
          <span className="tab-badge" style={{ ["--badge-color" as string]: profile?.color }}>
            {badge}
          </span>
        )}
        <button
          className="tab-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void closeWithConfirm(project)}
        >
          ×
        </button>
      </div>
      {menu.element}
    </>
  );
}

export async function closeWithConfirm(project: Project) {
  const st = useWorkspace.getState();
  const busy = Object.keys(project.panes).some((id) => ["working", "blocked"].includes(st.statuses[id]?.state ?? ""));
  if (busy && !(await ask(`"${project.name}" has an active Claude session. Close it anyway?`, { title: "Close project", kind: "warning" }))) return;
  if (!(await confirmProjectEditors(project.id))) return;
  st.closeProject(project.id);
}
