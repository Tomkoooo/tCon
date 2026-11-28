import { Fragment, useRef } from "react";
import { writeText } from "./clipboard";
import { useWorkspace } from "../../store/workspace";
import type { EditorGroup, EditorTab, Project } from "../../types";
import { EditorPane } from "../editor/EditorPane";
import { closeEditors } from "../editor/editorActions";
import { FileIcon } from "../FileIcon";
import { useContextMenu } from "../ContextMenu";
import { dragResize } from "./drag";
import { halfOf, insertIndex, startTabDrag } from "./tabDrag";
import { BoardView } from "../tasks/BoardView";
import { Icon } from "../icons";
import { BrowserTab, BrowserTabIcon, BrowserTabName } from "../browser/BrowserTab";
import { hostOf } from "../../browser/api";
import { HelpView } from "../help/HelpView";
import { CommitView, commitIdOf } from "../editor/CommitView";

const DRAG_KIND = "editor-tab";

/** Drop zone for an editor tab dragged over `target`: before/after a tab, the end of a tab strip,
 *  or the center/right half of a group's body (right opens a new group). */
function editorDropZone(projectId: string, tabId: string, canSplit: boolean) {
  return (target: HTMLElement, ev: PointerEvent): string | null => {
    const role = target.dataset.role;
    if (role === "tab") return halfOf(target, ev);
    if (role === "strip") return "end";
    const r = target.getBoundingClientRect();
    if (canSplit && ev.clientX > r.left + r.width * 0.65) return "right";
    const group = useWorkspace.getState().projects[projectId]?.editorGroups.find((g) => g.id === target.dataset.group);
    const inGroup = !!group?.tabs.some((t) => t.id === tabId);
    return inGroup ? null : "center";
  };
}

function dropEditorTab(projectId: string, tabId: string, target: HTMLElement, zone: string) {
  const st = useWorkspace.getState();
  const groupId = target.dataset.group;
  const group = st.projects[projectId]?.editorGroups.find((g) => g.id === groupId);
  if (!groupId || !group) return;
  if (zone === "right") return st.moveEditorTab(projectId, tabId, "new", undefined, groupId);
  if (zone === "before" || zone === "after") {
    const to = group.tabs.findIndex((t) => t.id === target.dataset.id);
    if (to < 0) return;
    const from = group.tabs.findIndex((t) => t.id === tabId);
    return st.moveEditorTab(projectId, tabId, groupId, insertIndex(from, to, zone === "after"));
  }
  st.moveEditorTab(projectId, tabId, groupId);
}
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function EditorArea({ project }: { project: Project }) {
  const ref = useRef<HTMLDivElement>(null);
  const resizeEditorGroups = useWorkspace((s) => s.resizeEditorGroups);
  const groups = project.editorGroups;

  const startDrag = (index: number, e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const total = el.getBoundingClientRect().width;
    const startX = e.clientX;
    const start = [...project.editorGroupSizes];
    const pair = start[index] + start[index + 1];
    dragResize(e, "col-resize", (ev) => {
      const a = Math.max(10, Math.min(pair - 10, start[index] + ((ev.clientX - startX) / total) * 100));
      const sizes = [...start];
      sizes[index] = a;
      sizes[index + 1] = pair - a;
      resizeEditorGroups(project.id, sizes);
    });
  };

  return (
    <div className="editor-area" ref={ref}>
      {groups.map((g, i) => (
        <Fragment key={g.id}>
          {i > 0 && <div className="split-divider vertical" onPointerDown={(e) => startDrag(i - 1, e)} />}
          <div className="ed-group-host" style={{ flex: `${project.editorGroupSizes[i] ?? 1} 1 0` }}>
            <EditorGroupView project={project} group={g} canSplit={groups.length < 4} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function EditorGroupView({ project, group, canSplit }: { project: Project; group: EditorGroup; canSplit: boolean }) {
  const st = useWorkspace.getState();
  const active = project.focusArea === "editor" && project.activeEditorGroupId === group.id;
  const activeTab = group.tabs.find((t) => t.id === group.activeTabId);

  return (
    <div className={`ed-group${active ? " active" : ""}`} onMouseDownCapture={() => st.focusEditorGroup(project.id, group.id)}>
      <div className="ed-tabs" data-drop-kind={DRAG_KIND} data-role="strip" data-group={group.id}>
        <div className="ed-tabs-scroll">
          {group.tabs.map((t, i) => (
            <EditorTabButton key={t.id} project={project} group={group} tab={t} index={i} canSplit={canSplit} />
          ))}
        </div>
        <div className="ed-tabs-actions">
          {canSplit && activeTab && group.tabs.length > 1 && (
            <button className="icon-btn" title="Move to new group on the right (⌘\)" onClick={() => st.moveEditorTab(project.id, activeTab.id, "new")}>
              <Icon name="splitRight" />
            </button>
          )}
        </div>
      </div>
      <div className="ed-group-body" data-drop-kind={DRAG_KIND} data-role="body" data-group={group.id}>
        {group.tabs.map((t) => (
          // All tabs stay mounted so unsaved buffers survive tab switches.
          <div key={t.id} className="ed-tab-body" style={{ display: t.id === group.activeTabId ? undefined : "none" }}>
            {t.kind === "board" ? <BoardView project={project} /> : t.kind === "browser" ? <BrowserTab project={project} tab={t} /> : t.kind === "help" ? <HelpView /> : t.kind === "commit" ? <CommitView root={project.rootPath} path={t.path} /> : <EditorPane tabId={t.id} path={t.path} root={project.rootPath} diff={t.diff} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function EditorTabButton({ project, group, tab, index, canSplit }: { project: Project; group: EditorGroup; tab: EditorTab; index: number; canSplit: boolean }) {
  const st = useWorkspace.getState();
  const dirty = useWorkspace((s) => !!s.dirtyEditors[tab.id]);
  const menu = useContextMenu();
  const active = tab.id === group.activeTabId;
  const name = tab.kind === "board" ? "Tasks" : tab.kind === "browser" ? hostOf(tab.path) : tab.kind === "help" ? "Help" : tab.kind === "commit" ? commitIdOf(tab.path).slice(0, 7) : tab.diff && !tab.diff.file ? "Changes" : baseName(tab.path);
  const rel = tab.path.startsWith(project.rootPath + "/") ? tab.path.slice(project.rootPath.length + 1) : tab.path;
  // Disambiguate same-named files with their parent folder (VS Code style).
  const dupe = group.tabs.some((t) => t.id !== tab.id && baseName(t.path) === baseName(tab.path));
  const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")).split("/").pop() : "";

  const close = () => void closeEditors(project.id, [tab.id]);
  const onContextMenu = (e: React.MouseEvent) => {
    const ids = group.tabs.map((t) => t.id);
    menu.open(e, [
      { label: "Close", hint: "⌘W", action: close },
      { label: "Close Others", action: () => void closeEditors(project.id, ids.filter((id) => id !== tab.id)) },
      { label: "Close to the Right", action: () => void closeEditors(project.id, ids.slice(index + 1)) },
      { label: "Close All", action: () => void closeEditors(project.id, ids) },
      "sep",
      ...(tab.preview ? [{ label: "Keep Open", action: () => st.pinEditorTab(project.id, tab.id) }] : []),
      { label: "Move to New Group (Split Right)", hint: "⌘\\", action: () => st.moveEditorTab(project.id, tab.id, "new") },
      "sep",
      { label: "Copy Path", action: () => void writeText(tab.path) },
      { label: "Copy Relative Path", action: () => void writeText(rel) },
    ]);
  };

  return (
    <>
      <div
        className={`ed-tab${active ? " active" : ""}${tab.preview ? " preview" : ""}${dirty ? " dirty" : ""}`}
        style={{ ["--pane-accent" as string]: project.color }}
        title={tab.path}
        data-drop-kind={DRAG_KIND}
        data-role="tab"
        data-group={group.id}
        data-id={tab.id}
        onPointerDown={(e) =>
          startTabDrag(e, { kind: DRAG_KIND, zone: editorDropZone(project.id, tab.id, canSplit), drop: (target, zone) => dropEditorTab(project.id, tab.id, target, zone) })
        }
        onMouseDown={(e) => e.button === 0 && st.setActiveEditorTab(project.id, group.id, tab.id)}
        onDoubleClick={() => st.pinEditorTab(project.id, tab.id)}
        onAuxClick={(e) => e.button === 1 && close()}
        onContextMenu={onContextMenu}
      >
        {tab.kind === "board" ? (
          <Icon name="board" size={14} className="ed-tab-icon" />
        ) : tab.kind === "browser" ? (
          <BrowserTabIcon tabId={tab.id} />
        ) : tab.kind === "help" ? (
          <Icon name="help" size={14} className="ed-tab-icon" />
        ) : tab.kind === "commit" ? (
          <Icon name="commit" size={14} className="ed-tab-icon" />
        ) : (
          <FileIcon name={baseName(tab.path) || name} />
        )}
        <span className="ed-tab-name">{tab.kind === "browser" ? <BrowserTabName tab={tab} /> : name}</span>
        {tab.diff && <span className="ed-tab-desc">{tab.diff.staged ? "staged" : "diff"}</span>}
        {tab.kind === "commit" && <span className="ed-tab-desc">commit</span>}
        {!tab.diff && !tab.kind && dupe && parent && <span className="ed-tab-desc">{parent}</span>}
        <button className="ed-tab-close" title="Close (⌘W)" aria-label={`Close ${name}`} onMouseDown={(e) => e.stopPropagation()} onClick={close}>
          <Icon name="close" size={14} className="x" />
          <span className="dot" />
        </button>
      </div>
      {menu.element}
    </>
  );
}
