import { Fragment, useRef, useState } from "react";
import { writeText } from "./clipboard";
import { useWorkspace } from "../../store/workspace";
import type { EditorGroup, EditorTab, Project } from "../../types";
import { EditorPane } from "../editor/EditorPane";
import { closeEditors } from "../editor/editorActions";
import { FileIcon } from "../FileIcon";
import { useContextMenu } from "../ContextMenu";
import { dragResize } from "./drag";
import { BoardView } from "../tasks/BoardView";
import { Icon } from "../icons";
import { BrowserTab, BrowserTabIcon, BrowserTabName } from "../browser/BrowserTab";
import { hostOf } from "../../browser/api";
import { HelpView } from "../help/HelpView";
import { CommitView, commitIdOf } from "../editor/CommitView";

const DRAG_TYPE = "text/tcon-editor-tab";
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
  const [drop, setDrop] = useState<null | "center" | "right">(null);
  const activeTab = group.tabs.find((t) => t.id === group.activeTabId);

  const onBodyDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDrop(canSplit && e.clientX > r.left + r.width * 0.65 ? "right" : "center");
  };
  const onBodyDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const zone = drop;
    setDrop(null);
    if (!id) return;
    if (zone === "right") st.moveEditorTab(project.id, id, "new", undefined, group.id);
    else if (!group.tabs.some((t) => t.id === id)) st.moveEditorTab(project.id, id, group.id);
  };

  return (
    <div className={`ed-group${active ? " active" : ""}`} onMouseDownCapture={() => st.focusEditorGroup(project.id, group.id)}>
      <div
        className="ed-tabs"
        onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && e.preventDefault()}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(DRAG_TYPE);
          if (id && e.target === e.currentTarget) st.moveEditorTab(project.id, id, group.id);
        }}
      >
        <div className="ed-tabs-scroll">
          {group.tabs.map((t, i) => (
            <EditorTabButton key={t.id} project={project} group={group} tab={t} index={i} />
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
      <div className="ed-group-body" onDragOver={onBodyDragOver} onDragLeave={() => setDrop(null)} onDrop={onBodyDrop}>
        {group.tabs.map((t) => (
          // All tabs stay mounted so unsaved buffers survive tab switches.
          <div key={t.id} className="ed-tab-body" style={{ display: t.id === group.activeTabId ? undefined : "none" }}>
            {t.kind === "board" ? <BoardView project={project} /> : t.kind === "browser" ? <BrowserTab project={project} tab={t} /> : t.kind === "help" ? <HelpView /> : t.kind === "commit" ? <CommitView root={project.rootPath} path={t.path} /> : <EditorPane tabId={t.id} path={t.path} root={project.rootPath} diff={t.diff} />}
          </div>
        ))}
        {drop && <div className={`ed-drop-overlay ${drop}`} />}
      </div>
    </div>
  );
}

function EditorTabButton({ project, group, tab, index }: { project: Project; group: EditorGroup; tab: EditorTab; index: number }) {
  const st = useWorkspace.getState();
  const dirty = useWorkspace((s) => !!s.dirtyEditors[tab.id]);
  const menu = useContextMenu();
  const [dragOver, setDragOver] = useState(false);
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
        className={`ed-tab${active ? " active" : ""}${tab.preview ? " preview" : ""}${dirty ? " dirty" : ""}${dragOver ? " drop" : ""}`}
        style={{ ["--pane-accent" as string]: project.color }}
        title={tab.path}
        draggable
        onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, tab.id)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.stopPropagation();
          setDragOver(false);
          const id = e.dataTransfer.getData(DRAG_TYPE);
          if (id && id !== tab.id) st.moveEditorTab(project.id, id, group.id, index);
        }}
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
