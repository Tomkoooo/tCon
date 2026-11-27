// Shared domain types. Mirrors the Rust serde structs (camelCase).

export type SessionState = "idle" | "working" | "blocked" | "done" | "error" | "unknown" | "exited";

export interface ProgramStatus {
  state: string; // idle | working | blocked | done | error | clear
  app?: string | null;
  id?: string | null;
  kind?: string | null; // permission | question | auth
  progress?: number | null;
  title?: string | null;
  msg?: string | null;
}

export interface PaneStatus {
  state: SessionState;
  kind?: string | null;
  progress?: number | null;
  title?: string | null;
  msg?: string | null;
  /** true once the user has looked at a "done"/"blocked" pane */
  seen: boolean;
  at: number;
}

export interface Pane {
  id: string;
  title: string;
  cwd: string;
  isClaude: boolean;
  startupCommand?: string;
  profileId?: string | null;
  lastActivity: number;
  exited?: boolean;
  exitCode?: number | null;
}

/** Split layout tree inside a terminal tab. */
export type LayoutNode =
  | { type: "terminal"; paneId: string }
  | { type: "split"; id: string; direction: "row" | "column"; children: LayoutNode[]; sizes: number[] };

/** A tab in the terminal panel; holds one or more split terminals. */
export interface TerminalTab { id: string; layout: LayoutNode }

export interface EditorTab {
  id: string;
  path: string;
  /** VS Code-style preview tab: replaced by the next single-click open until pinned. */
  preview?: boolean;
  diff?: { file: string | null; staged: boolean } | null;
}
export interface EditorGroup { id: string; tabs: EditorTab[]; activeTabId: string | null }

export type PanelPosition = "bottom" | "top" | "left" | "right";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  color: string;
  profileId?: string | null;
  accountLabel?: string | null;
  lastInteracted: number;
  panes: Record<string, Pane>;
  terminalTabs: TerminalTab[];
  activeTerminalTabId: string | null;
  /** last focused terminal pane */
  focusedPaneId?: string | null;
  editorGroups: EditorGroup[];
  activeEditorGroupId: string | null;
  editorGroupSizes: number[];
  /** which area keyboard shortcuts like ⌘W apply to */
  focusArea: "terminal" | "editor";
  panelPosition: PanelPosition;
  /** panel share of the workbench, in percent (when editors are open) */
  panelSize: number;
  panelMaximized: boolean;
  panelHidden: boolean;
  sidebarOpen: boolean;
  sidebarTab: "files" | "git";
  sidebarWidth: number;
}

export interface RecentPath { path: string; lastUsed: number; pinned: boolean }

export interface Profile { id: string; name: string; color: string; env: Record<string, string> }

export interface GitFileStatus { path: string; index: string; worktree: string }
export interface GitStatus {
  isRepo: boolean;
  root?: string | null;
  branch?: string | null;
  head?: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  files: GitFileStatus[];
}
export interface GitCommit { id: string; shortId: string; summary: string; author: string; time: number; parents: string[]; refs: string[] }
export interface GitBranch { name: string; isRemote: boolean; isHead: boolean; upstream?: string | null; target: string }
export interface GitWorktree { name: string; path: string; branch?: string | null; isMain: boolean }

export interface FsEntry { name: string; path: string; isDir: boolean; isSymlink: boolean; size: number; modified: number }
export interface FileContent { content: string; isBinary: boolean; tooLarge: boolean; size: number }

/** Emitted as "fs-changed" by fs_watch. */
export interface FsChangedEvent { root: string; paths: string[]; git: boolean }
