// Typed wrappers around Tauri commands. All backend access goes through here.
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AuthStatus, FileContent, FsEntry, GitBranch, GitCommit, GitCommitDetails, GitOp, GitStatus, GitWorktree, Profile, RecentPath,
} from "./types";

export interface SpawnOptions {
  paneId: string;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  startupCommand?: string | null;
}

export const api = {
  // PTY
  ptySpawn: (opts: SpawnOptions, onData: (data: Uint8Array) => void) => {
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => onData(new Uint8Array(buf));
    return invoke<void>("pty_spawn", { opts, onData: ch });
  },
  ptyWrite: (paneId: string, data: string) => invoke<void>("pty_write", { paneId, data }),
  ptyResize: (paneId: string, cols: number, rows: number) => invoke<void>("pty_resize", { paneId, cols, rows }),
  ptyKill: (paneId: string) => invoke<void>("pty_kill", { paneId }),
  ptyForeground: (paneId: string) => invoke<string | null>("pty_foreground", { paneId }),

  // Persistence
  recentList: (limit = 20) => invoke<RecentPath[]>("recent_list", { limit }),
  recentTouch: (path: string) => invoke<void>("recent_touch", { path }),
  recentPin: (path: string, pinned: boolean) => invoke<void>("recent_pin", { path, pinned }),
  recentRemove: (path: string) => invoke<void>("recent_remove", { path }),
  profilesList: () => invoke<Profile[]>("profiles_list"),
  profileSave: (profile: Profile) => invoke<void>("profile_save", { profile }),
  profileDelete: (id: string) => invoke<void>("profile_delete", { id }),
  settingGet: (key: string) => invoke<string | null>("setting_get", { key }),
  settingSet: (key: string, value: string) => invoke<void>("setting_set", { key, value }),
  homeDir: () => invoke<string>("home_dir"),

  // Git
  gitStatus: (path: string) => invoke<GitStatus>("git_status", { path }),
  gitLog: (path: string, limit = 200, currentOnly = false) => invoke<GitCommit[]>("git_log", { path, limit, currentOnly }),
  gitCommitDetails: (root: string, id: string) => invoke<GitCommitDetails>("git_commit_details", { root, id }),
  gitCommitDiff: (root: string, id: string) => invoke<string>("git_commit_diff", { root, id }),
  gitBranches: (path: string) => invoke<GitBranch[]>("git_branches", { path }),
  gitWorktrees: (path: string) => invoke<GitWorktree[]>("git_worktrees", { path }),
  gitDiff: (path: string, file: string | null, staged: boolean) => invoke<string>("git_diff", { path, file, staged }),
  gitOp: (path: string, op: GitOp) => invoke<string>("git_op", { path, op }),

  // Claude accounts
  claudeAuthStatus: (configDir: string | null) => invoke<AuthStatus>("claude_auth_status", { configDir }),
  claudeAuthLogout: (configDir: string | null) => invoke<void>("claude_auth_logout", { configDir }),
  accountPrepareDir: (dir: string) => invoke<void>("account_prepare_dir", { dir }),

  // Theming / config (~/.tcon)
  themesScan: () => invoke<import("./theming/types").ThemeCatalog>("themes_scan"),
  themeLoad: (path: string) => invoke<import("./theming/types").ColorThemeData>("theme_load", { path }),
  iconThemeLoad: (path: string) => invoke<unknown>("icon_theme_load", { path }),
  themeAsset: (path: string) => invoke<string>("theme_asset", { path }),
  configInit: () => invoke<string>("config_init"),
  configRead: (name: string) => invoke<string>("config_read", { name }),
  configWrite: (name: string, content: string) => invoke<void>("config_write", { name, content }),

  // FS
  fsListDir: (path: string, showHidden = false) => invoke<FsEntry[]>("fs_list_dir", { path, showHidden }),
  fsReadText: (path: string) => invoke<FileContent>("fs_read_text", { path }),
  fsWriteText: (path: string, content: string) => invoke<void>("fs_write_text", { path, content }),
  fsCreateProjectDir: (path: string, gitInit: boolean) => invoke<void>("fs_create_project_dir", { path, gitInit }),
  fsWatch: (root: string) => invoke<void>("fs_watch", { root }),
  fsUnwatch: (root: string) => invoke<void>("fs_unwatch", { root }),
};
