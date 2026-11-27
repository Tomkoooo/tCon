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
  /** extra env for this pane only (e.g. a login flow for a specific account) */
  env?: Record<string, string>;
  /** not persisted across app restarts (e.g. login terminals) */
  ephemeral?: boolean;
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
  /** non-file editor: "board" = the project's task board (path is virtual) */
  kind?: "board";
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
  /** extra env vars for every terminal in this project (overrides the account / legacy profile) */
  env?: Record<string, string> | null;
  /** Claude model override for new sessions (null = global "claude.model" setting) */
  claudeModel?: string | null;
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
  sidebarTab: "files" | "git" | "tasks";
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
  upstream?: string | null;
  hasRemote: boolean;
  stashCount: number;
}

export type GitOp =
  | { op: "stage"; files: string[] }
  | { op: "stageAll" }
  | { op: "unstage"; files: string[] }
  | { op: "unstageAll" }
  | { op: "discard"; tracked: string[]; untracked: string[] }
  | { op: "commit"; message: string; amend: boolean }
  | { op: "push" }
  | { op: "pull" }
  | { op: "fetch" }
  | { op: "checkout"; branch: string }
  | { op: "createBranch"; name: string }
  | { op: "stash" }
  | { op: "stashPop" };

/** A Claude Code login = one CLAUDE_CONFIG_DIR (null = the default ~/.claude). */
export interface Account { id: string; configDir: string | null }

/** Subset of `claude auth status --json`. */
export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  planTier?: string;
}
export type CommitSync = "outgoing" | "incoming" | "local";
export interface GitCommit { id: string; shortId: string; summary: string; author: string; time: number; parents: string[]; refs: string[]; sync?: CommitSync | null }
export interface GitBranch { name: string; isRemote: boolean; isHead: boolean; upstream?: string | null; target: string }
export interface GitWorktree { name: string; path: string; branch?: string | null; isMain: boolean }

export interface FsEntry { name: string; path: string; isDir: boolean; isSymlink: boolean; size: number; modified: number }
export interface FileContent { content: string; isBinary: boolean; tooLarge: boolean; size: number }

/** Emitted as "fs-changed" by fs_watch. */
export interface FsChangedEvent { root: string; paths: string[]; git: boolean }
