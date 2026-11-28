// Bookmark folders in the tab bar: named groups of project paths (e.g. "SIRONIC"). Clicking a
// folder opens a dropdown of its projects; picking one brings it to the first tab (opening it
// first if it isn't open). Folders live in settings.json under `projects.folders`.
import { useState } from "react";
import { create } from "zustand";
import { useTheming } from "../theming/store";
import { PALETTE, useWorkspace } from "../store/workspace";
import type { Project } from "../types";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./icons";

export const FOLDERS_SETTING = "projects.folders";

export interface ProjectFolder {
  id: string;
  name: string;
  paths: string[];
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const baseName = (p: string) => trim(p).split("/").pop() || p;

function parseFolders(raw: unknown): ProjectFolder[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is ProjectFolder => !!f && typeof f === "object" && typeof f.name === "string")
    .map((f, i) => ({
      id: typeof f.id === "string" && f.id ? f.id : `folder-${i}`,
      name: f.name,
      paths: Array.isArray(f.paths) ? f.paths.filter((p): p is string => typeof p === "string").map(trim) : [],
    }));
}

export function useFolders(): ProjectFolder[] {
  return parseFolders(useTheming((s) => s.settings[FOLDERS_SETTING]));
}

function getFolders(): ProjectFolder[] {
  return parseFolders(useTheming.getState().settings[FOLDERS_SETTING]);
}

function saveFolders(folders: ProjectFolder[]) {
  void useTheming.getState().setSetting(FOLDERS_SETTING, folders);
}

function editFolder(id: string, fn: (f: ProjectFolder) => ProjectFolder | null) {
  saveFolders(getFolders().flatMap((f) => (f.id === id ? (fn(f) ?? []) : [f])));
}

/** Which folder button shows its name input (set right after "New Folder…"). */
const useFolderUi = create<{ renaming: string | null; setRenaming(id: string | null): void }>((set) => ({
  renaming: null,
  setRenaming: (renaming) => set({ renaming }),
}));

export function addToFolder(folderId: string, path: string) {
  const p = trim(path);
  editFolder(folderId, (f) => (f.paths.includes(p) ? f : { ...f, paths: [...f.paths, p] }));
}

export function removeFromFolder(folderId: string, path: string) {
  const p = trim(path);
  editFolder(folderId, (f) => ({ ...f, paths: f.paths.filter((x) => x !== p) }));
}

/** Create a folder (optionally holding `path`) and start renaming it. */
export function newFolder(path?: string) {
  const id = crypto.randomUUID();
  saveFolders([...getFolders(), { id, name: "New folder", paths: path ? [trim(path)] : [] }]);
  useFolderUi.getState().setRenaming(id);
}

function openProjectFor(path: string): Project | undefined {
  return Object.values(useWorkspace.getState().projects).find((p) => trim(p.rootPath) === trim(path));
}

/** Bring a folder's project to the first tab and focus it, opening it if needed. */
export function openFromFolder(path: string) {
  const ws = useWorkspace.getState();
  const open = openProjectFor(path);
  const id = open ? open.id : ws.openProject({ path, color: PALETTE[ws.order.length % PALETTE.length], profileId: null, claude: false });
  ws.moveProject(id, 0);
  ws.setActive(id);
}

/** "Bookmark Folder" entries for a project tab's context menu. */
export function folderMenuItems(project: Project): MenuItem[] {
  const folders = getFolders();
  const path = trim(project.rootPath);
  return [
    ...folders.map((f): MenuItem =>
      f.paths.includes(path)
        ? { label: `Remove from "${f.name}"`, action: () => removeFromFolder(f.id, path) }
        : { label: `Add to "${f.name}"`, action: () => addToFolder(f.id, path) },
    ),
    { label: "Add to New Folder…", action: () => newFolder(path) },
  ];
}

export function FolderButtons() {
  const folders = useFolders();
  return (
    <>
      {folders.map((f) => (
        <FolderButton key={f.id} folder={f} />
      ))}
    </>
  );
}

function FolderButton({ folder }: { folder: ProjectFolder }) {
  const menu = useContextMenu();
  const renaming = useFolderUi((s) => s.renaming === folder.id);
  const setRenaming = useFolderUi((s) => s.setRenaming);
  const projects = useWorkspace((s) => s.projects);
  const activeId = useWorkspace((s) => s.activeProjectId);
  const [dragOver, setDragOver] = useState(false);

  const active = activeId ? projects[activeId] : undefined;
  const activePath = active ? trim(active.rootPath) : null;

  const rows = (): MenuItem[] => {
    const items: MenuItem[] = folder.paths.length
      ? folder.paths.map((path): MenuItem => {
          const open = openProjectFor(path);
          return {
            custom: (
              <div
                role="menuitem"
                className="ctx-item folder-item"
                title={path}
                onClick={() => {
                  menu.close();
                  openFromFolder(path);
                }}
              >
                <span className="folder-dot" style={{ background: open?.color ?? "transparent", borderColor: open?.color ?? "var(--fg-dim)" }} />
                <span className="ctx-label">{open?.name ?? baseName(path)}</span>
                {open && <span className="kbd-hint">{open.id === activeId ? "current" : "open"}</span>}
                <button
                  className="folder-remove"
                  title="Remove from folder"
                  aria-label={`Remove ${baseName(path)} from ${folder.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    menu.close();
                    removeFromFolder(folder.id, path);
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ),
          };
        })
      : [{ header: "Empty: right-click a tab or drop it here" }];
    items.push("sep");
    if (active && activePath && !folder.paths.includes(activePath)) {
      items.push({ label: `Add "${active.name}"`, action: () => addToFolder(folder.id, activePath) });
    }
    items.push({ label: "Rename…", action: () => setRenaming(folder.id) });
    items.push({ label: "Delete Folder", danger: true, action: () => editFolder(folder.id, () => null) });
    return items;
  };

  if (renaming) {
    return (
      <div className="tab-folder editing">
        <Icon name="folder" size={14} />
        <input
          autoFocus
          defaultValue={folder.name}
          onFocus={(e) => e.target.select()}
          style={{ padding: "1px 4px", width: 120 }}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== folder.name) editFolder(folder.id, (f) => ({ ...f, name }));
            setRenaming(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setRenaming(null);
          }}
        />
      </div>
    );
  }

  return (
    <>
      <button
        className={`tab-folder${dragOver ? " drag-over" : ""}`}
        title={`${folder.name}: ${folder.paths.length} project${folder.paths.length === 1 ? "" : "s"}`}
        onClick={(e) => menu.open(e, rows(), { anchor: "below-start", minWidth: 220 })}
        onContextMenu={(e) =>
          menu.open(e, [
            { label: "Rename…", action: () => setRenaming(folder.id) },
            { label: "Delete Folder", danger: true, action: () => editFolder(folder.id, () => null) },
          ])
        }
        onDoubleClick={() => setRenaming(folder.id)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("text/tcon-project")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const p = useWorkspace.getState().projects[e.dataTransfer.getData("text/tcon-project")];
          if (p) addToFolder(folder.id, p.rootPath);
        }}
      >
        <Icon name="folder" size={14} />
        <span className="tab-name">{folder.name}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {menu.element}
    </>
  );
}
