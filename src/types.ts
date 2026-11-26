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

/** Split layout tree inside a project group. */
export type LayoutNode =
  | { type: "terminal"; paneId: string }
  | { type: "editor"; path: string; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; children: LayoutNode[]; sizes: number[] };

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  color: string;
  profileId?: string | null;
  accountLabel?: string | null;
  lastInteracted: number;
  panes: Record<string, Pane>;
  layout: LayoutNode | null;
  focusedPaneId?: string | null;
  sidebarOpen: boolean;
  sidebarTab: "files" | "git";
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
