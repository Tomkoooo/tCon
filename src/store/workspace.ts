import { create } from "zustand";
import { api } from "../api";
import type {
  EditorGroup, EditorTab, GitStatus, Pane, PaneStatus, PanelPosition, ProgramStatus, Profile, Project, SessionState, TerminalTab,
} from "../types";
import { equal, insertPane, paneIds, removePane, sanitize, setSizes, uid } from "./layout";
import { terminals } from "../terminal/registry";
import { accountEnv, useAccounts } from "./accounts";
import { withClaudeModel } from "../claudeModel";
import { isSessionId, resumeCommand, withSessionTracking } from "../claudeSessions";

export const PALETTE = ["#6aa7ff", "#5fc48a", "#e5b450", "#ef5f5f", "#b884f0", "#4fc6c6", "#f08a4b", "#e57ab8", "#9aa3ad"];
export const INACTIVE_AFTER_MS = 30 * 60 * 1000;
const CLAUDE_CMD = "claude";
const MAX_EDITOR_GROUPS = 4;

export type Modal =
  | null
  | { kind: "newProject" }
  | { kind: "profiles"; section?: string } /* = Settings */
  | { kind: "projectSettings"; projectId: string };

export interface OpenProjectArgs {
  path: string;
  name?: string;
  color?: string;
  profileId?: string | null;
  claude: boolean;
}

export interface OpenEditorOpts {
  /** single-click open: reuse the group's preview tab */
  preview?: boolean;
  diff?: { file: string | null; staged: boolean } | null;
  groupId?: string;
  kind?: EditorTab["kind"];
}

export interface AddTerminalOpts {
  claude: boolean;
  split?: "row" | "column";
  command?: string;
  title?: string;
  env?: Record<string, string>;
  ephemeral?: boolean;
  /** open as a new tab without switching to it, focusing it or showing a hidden panel */
  background?: boolean;
  /** tab group (task agents' terminals are grouped under "agents") */
  group?: TerminalTab["group"];
}

type ProjectPatch = Partial<Pick<Project, "name" | "color" | "profileId" | "accountLabel" | "env" | "claudeModel" | "browserUrl" | "sidebarOpen" | "sidebarTab" | "sidebarWidth">>;

interface WorkspaceState {
  loaded: boolean;
  projects: Record<string, Project>;
  order: string[];
  activeProjectId: string | null;
  statuses: Record<string, PaneStatus>;
  gitStatus: Record<string, GitStatus | null>;
  /** editor tab id → has unsaved changes (runtime only) */
  dirtyEditors: Record<string, boolean>;
  profiles: Profile[];
  modal: Modal;
  showInactive: boolean;
  defaultPanelPosition: PanelPosition;

  // projects
  openProject(args: OpenProjectArgs): string;
  closeProject(id: string): void;
  setActive(id: string): void;
  cycleProject(delta: number): void;
  updateProject(id: string, patch: ProjectPatch): void;
  moveProject(id: string, toIndex: number): void;

  // terminals
  addTerminal(projectId: string, opts: AddTerminalOpts): string;
  closePane(projectId: string, paneId: string): void;
  closeTerminalTab(projectId: string, tabId: string): void;
  setActiveTerminalTab(projectId: string, tabId: string): void;
  moveTerminalTab(projectId: string, tabId: string, toIndex: number): void;
  movePaneToNewTab(projectId: string, paneId: string): void;
  focusPane(projectId: string, paneId: string): void;
  focusAdjacent(delta: number): void;
  cycleTab(delta: number): void;
  /** Respawn a pane (kills it first if still running). */
  restartPane(paneId: string, command?: string): void;
  resizeSplit(projectId: string, splitId: string, sizes: number[]): void;

  // editors
  openEditor(projectId: string, path: string, opts?: OpenEditorOpts): void;
  closeEditorTab(projectId: string, tabId: string): void;
  setActiveEditorTab(projectId: string, groupId: string, tabId: string): void;
  pinEditorTab(projectId: string, tabId: string): void;
  /** Change a tab's path in place (a browser tab follows its page's URL). */
  setEditorTabPath(projectId: string, tabId: string, path: string): void;
  /** Move a tab into another group (or "new" = a new group right of its current one). */
  moveEditorTab(projectId: string, tabId: string, toGroupId: string | "new", toIndex?: number, anchorGroupId?: string): void;
  focusEditorGroup(projectId: string, groupId: string): void;
  resizeEditorGroups(projectId: string, sizes: number[]): void;
  setEditorDirty(tabId: string, dirty: boolean): void;

  // workbench layout
  setFocusArea(projectId: string, area: Project["focusArea"]): void;
  setPanelPosition(projectId: string, pos: PanelPosition): void;
  setPanelSize(projectId: string, size: number): void;
  togglePanelMaximized(projectId: string): void;
  togglePanel(projectId: string): void;

  // runtime events
  markActivity(paneId: string): void;
  setPaneTitle(paneId: string, title: string): void;
  /** Record the Claude session a pane runs (for resume). */
  setPaneSession(paneId: string, sessionId: string): void;
  setProgramStatus(paneId: string, st: ProgramStatus): void;
  markSeen(paneId: string): void;
  setExited(paneId: string, code: number | null): void;
  setGitStatus(projectId: string, st: GitStatus | null): void;

  // misc
  setModal(m: Modal): void;
  setShowInactive(v: boolean): void;
  loadProfiles(): Promise<void>;
  restore(): Promise<void>;
}

export function findPane(s: Pick<WorkspaceState, "projects">, paneId: string): [Project, Pane] | null {
  for (const p of Object.values(s.projects)) if (p.panes[paneId]) return [p, p.panes[paneId]];
  return null;
}

export function tabOfPane(p: Project, paneId: string): TerminalTab | undefined {
  return p.terminalTabs.find((t) => paneIds(t.layout).includes(paneId));
}

export function findEditorTab(p: Project, tabId: string): [EditorGroup, EditorTab] | null {
  for (const g of p.editorGroups) {
    const t = g.tabs.find((x) => x.id === tabId);
    if (t) return [g, t];
  }
  return null;
}

export function hasEditors(p: Project): boolean {
  return p.editorGroups.some((g) => g.tabs.length > 0);
}

/** Is this terminal pane currently on screen and focused? */
export function isPaneVisible(s: Pick<WorkspaceState, "projects" | "activeProjectId">, paneId: string): boolean {
  const found = findPane(s, paneId);
  if (!found) return false;
  const [p] = found;
  const panelShown = !p.panelHidden || !hasEditors(p);
  return (
    document.hasFocus() && s.activeProjectId === p.id && p.focusedPaneId === paneId && panelShown && tabOfPane(p, paneId)?.id === p.activeTerminalTabId
  );
}

export function profileEnv(profiles: Profile[], profileId?: string | null): Record<string, string> {
  return profiles.find((p) => p.id === profileId)?.env ?? {};
}

const STATE_PRIORITY: SessionState[] = ["blocked", "error", "working", "done", "idle", "exited", "unknown"];

/** Aggregate status of a set of panes = most urgent status. */
export function aggregateStatus(ids: string[], statuses: Record<string, PaneStatus>): PaneStatus | null {
  let best: PaneStatus | null = null;
  for (const id of ids) {
    const st = statuses[id];
    if (!st) continue;
    if (st.state === "done" && st.seen) {
      if (!best) best = st;
      continue;
    }
    if (!best || STATE_PRIORITY.indexOf(st.state) < STATE_PRIORITY.indexOf(best.state) || (best.state === "done" && best.seen)) best = st;
  }
  return best;
}

export function projectStatus(project: Project, statuses: Record<string, PaneStatus>): PaneStatus | null {
  return aggregateStatus(Object.keys(project.panes), statuses);
}

function nextColor(projects: Record<string, Project>) {
  const used = new Set(Object.values(projects).map((p) => p.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[Object.keys(projects).length % PALETTE.length];
}

function basename(p: string) {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function makePane(cwd: string, claude: boolean, profileId?: string | null, command?: string, extra?: Partial<Pane>): Pane {
  return {
    id: uid(),
    title: claude ? "Claude Code" : "shell",
    cwd,
    isClaude: claude,
    startupCommand: command ?? (claude ? CLAUDE_CMD : undefined),
    profileId: profileId ?? null,
    lastActivity: Date.now(),
    ...extra,
  };
}

/** Env for a pane: global Claude account < legacy project/pane profile < project env < pane-specific overrides. */
export function paneEnv(profiles: Profile[], project: Project, pane: Pane): Record<string, string> {
  return { ...accountEnv(), ...profileEnv(profiles, pane.profileId ?? project.profileId), ...(project.env ?? {}), ...(pane.env ?? {}) };
}

/** CLAUDE_CONFIG_DIR each pane's process was started with ("" = the default ~/.claude), so a
 *  usage limit can be pinned on the right account after the global account changed. */
const paneConfigDirs = new Map<string, string>();
export function paneConfigDir(paneId: string): string | null | undefined {
  const d = paneConfigDirs.get(paneId);
  return d === undefined ? undefined : d || null;
}
function recordConfigDir(paneId: string, env: Record<string, string>, always: boolean) {
  if (always || !paneConfigDirs.has(paneId)) paneConfigDirs.set(paneId, env.CLAUDE_CONFIG_DIR ?? "");
}

const sameDiff = (a: EditorTab["diff"], b: EditorTab["diff"]) =>
  (!a && !b) || (!!a && !!b && a.file === b.file && a.staged === b.staged);

/** Remove empty groups and keep sizes / active group consistent. */
function normalizeGroups(p: Project): Project {
  const keepIdx = p.editorGroups.map((g, i) => (g.tabs.length ? i : -1)).filter((i) => i >= 0);
  if (keepIdx.length === p.editorGroups.length && p.editorGroupSizes.length === keepIdx.length) {
    return p.activeEditorGroupId && p.editorGroups.some((g) => g.id === p.activeEditorGroupId)
      ? p
      : { ...p, activeEditorGroupId: p.editorGroups[0]?.id ?? null };
  }
  const groups = keepIdx.map((i) => p.editorGroups[i]);
  let sizes = keepIdx.map((i) => p.editorGroupSizes[i] ?? 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  sizes = total > 0 && sizes.length === groups.length ? sizes.map((s) => (s / total) * 100) : equal(groups.length);
  const active = groups.some((g) => g.id === p.activeEditorGroupId) ? p.activeEditorGroupId : groups[groups.length - 1]?.id ?? null;
  return { ...p, editorGroups: groups, editorGroupSizes: sizes, activeEditorGroupId: active, focusArea: groups.length ? p.focusArea : "terminal" };
}

const activityThrottle = new Map<string, number>();

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const patchProject = (id: string, fn: (p: Project) => Project) =>
    set((s) => (s.projects[id] ? { projects: { ...s.projects, [id]: fn(s.projects[id]) } } : s));

  const spawn = (project: Project, pane: Pane) => {
    const env = paneEnv(get().profiles, project, pane);
    recordConfigDir(pane.id, env, false);
    terminals.ensure(withSessionTracking(withClaudeModel(project, pane)), env);
  };

  const dropStatuses = (ids: string[]) =>
    set((s) => {
      const statuses = { ...s.statuses };
      ids.forEach((id) => delete statuses[id]);
      return { statuses };
    });

  /** Remove panes from a project (already disposed), fixing tabs + focus. */
  const removePanes = (projectId: string, ids: string[]) => {
    const project = get().projects[projectId];
    if (!project) return;
    const oldTabs = project.terminalTabs;
    const activeIdx = Math.max(0, oldTabs.findIndex((t) => t.id === project.activeTerminalTabId));
    const tabs: TerminalTab[] = [];
    for (const t of oldTabs) {
      let layout: TerminalTab["layout"] | null = t.layout;
      for (const id of ids) layout = removePane(layout, id);
      if (layout) tabs.push({ ...t, layout });
    }
    if (!tabs.length && !hasEditors(project)) {
      get().closeProject(projectId);
      return;
    }
    const panes = { ...project.panes };
    ids.forEach((id) => delete panes[id]);
    const activeTab = tabs.find((t) => t.id === project.activeTerminalTabId) ?? tabs[Math.min(activeIdx, tabs.length - 1)] ?? null;
    const inActive = activeTab ? paneIds(activeTab.layout) : [];
    const focusedPaneId = project.focusedPaneId && inActive.includes(project.focusedPaneId) ? project.focusedPaneId : inActive[inActive.length - 1] ?? null;
    patchProject(projectId, (p) => ({
      ...p,
      panes,
      terminalTabs: tabs,
      activeTerminalTabId: activeTab?.id ?? null,
      focusedPaneId,
      focusArea: tabs.length ? p.focusArea : "editor",
    }));
    dropStatuses(ids);
    if (focusedPaneId && get().projects[projectId]?.focusArea === "terminal") requestAnimationFrame(() => terminals.focus(focusedPaneId));
  };

  return {
    loaded: false,
    projects: {},
    order: [],
    activeProjectId: null,
    statuses: {},
    gitStatus: {},
    dirtyEditors: {},
    profiles: [],
    modal: null,
    showInactive: false,
    defaultPanelPosition: "bottom",

    openProject({ path, name, color, profileId, claude }) {
      const existing = Object.values(get().projects).find((p) => p.rootPath === path);
      if (existing) {
        get().setActive(existing.id);
        get().addTerminal(existing.id, { claude });
        return existing.id;
      }
      const pane = makePane(path, claude, profileId);
      const tab: TerminalTab = { id: uid(), layout: { type: "terminal", paneId: pane.id } };
      const project: Project = {
        id: uid(),
        name: name || basename(path),
        rootPath: path,
        color: color || nextColor(get().projects),
        profileId: profileId ?? null,
        lastInteracted: Date.now(),
        panes: { [pane.id]: pane },
        terminalTabs: [tab],
        activeTerminalTabId: tab.id,
        focusedPaneId: pane.id,
        editorGroups: [],
        activeEditorGroupId: null,
        editorGroupSizes: [],
        focusArea: "terminal",
        panelPosition: get().defaultPanelPosition,
        panelSize: 40,
        panelMaximized: false,
        panelHidden: false,
        sidebarOpen: true,
        sidebarTab: "files",
        sidebarWidth: 260,
      };
      set((s) => ({
        projects: { ...s.projects, [project.id]: project },
        order: [...s.order, project.id],
        activeProjectId: project.id,
      }));
      api.recentTouch(path).catch(() => {});
      api.fsWatch(path).catch(() => {});
      spawn(project, pane);
      return project.id;
    },

    closeProject(id) {
      const p = get().projects[id];
      if (!p) return;
      Object.keys(p.panes).forEach((pid) => terminals.dispose(pid));
      api.fsUnwatch(p.rootPath).catch(() => {});
      set((s) => {
        const projects = { ...s.projects };
        delete projects[id];
        const idx = s.order.indexOf(id);
        const order = s.order.filter((x) => x !== id);
        const statuses = { ...s.statuses };
        Object.keys(p.panes).forEach((pid) => delete statuses[pid]);
        const dirtyEditors = { ...s.dirtyEditors };
        p.editorGroups.forEach((g) => g.tabs.forEach((t) => delete dirtyEditors[t.id]));
        const activeProjectId = s.activeProjectId === id ? order[Math.min(idx, order.length - 1)] ?? null : s.activeProjectId;
        return { projects, order, statuses, dirtyEditors, activeProjectId };
      });
    },

    setActive(id) {
      if (!get().projects[id]) return;
      set({ activeProjectId: id });
      patchProject(id, (p) => ({ ...p, lastInteracted: Date.now() }));
      const p = get().projects[id];
      if (p.focusedPaneId) get().markSeen(p.focusedPaneId);
    },

    cycleProject(delta) {
      const { order, activeProjectId } = get();
      if (!order.length) return;
      const i = Math.max(0, order.indexOf(activeProjectId ?? ""));
      get().setActive(order[(i + delta + order.length) % order.length]);
    },

    updateProject(id, patch) {
      patchProject(id, (p) => ({ ...p, ...patch }));
    },

    moveProject(id, toIndex) {
      set((s) => {
        const order = s.order.filter((x) => x !== id);
        order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, id);
        return { order };
      });
    },

    // ---------------- terminals ----------------

    addTerminal(projectId, { claude, split, command, title, env, ephemeral, background, group }) {
      const project = get().projects[projectId];
      if (!project) return "";
      const focused = project.focusedPaneId ? project.panes[project.focusedPaneId] : undefined;
      const extra: Partial<Pane> = {};
      if (title) extra.title = title;
      if (env) extra.env = env;
      if (ephemeral) extra.ephemeral = true;
      const pane = makePane(focused?.cwd ?? project.rootPath, claude, project.profileId, command, extra);
      patchProject(projectId, (p) => {
        const activeIdx = p.terminalTabs.findIndex((t) => t.id === p.activeTerminalTabId);
        let tabs: TerminalTab[];
        let activeTerminalTabId: string;
        if (background && p.terminalTabs.length) {
          // Behind the scenes: append the tab, keep what the user is looking at.
          const tab: TerminalTab = { id: uid(), layout: { type: "terminal", paneId: pane.id }, ...(group ? { group } : {}) };
          return { ...p, panes: { ...p.panes, [pane.id]: pane }, terminalTabs: [...p.terminalTabs, tab] };
        }
        if (split && activeIdx >= 0) {
          const tab = p.terminalTabs[activeIdx];
          const target = p.focusedPaneId && paneIds(tab.layout).includes(p.focusedPaneId) ? p.focusedPaneId : null;
          tabs = p.terminalTabs.map((t, i) => (i === activeIdx ? { ...t, layout: insertPane(t.layout, target, pane.id, split) } : t));
          activeTerminalTabId = tab.id;
        } else {
          const tab: TerminalTab = { id: uid(), layout: { type: "terminal", paneId: pane.id }, ...(group ? { group } : {}) };
          tabs = [...p.terminalTabs];
          tabs.splice(activeIdx + 1, 0, tab);
          activeTerminalTabId = tab.id;
        }
        return {
          ...p,
          panes: { ...p.panes, [pane.id]: pane },
          terminalTabs: tabs,
          activeTerminalTabId,
          focusedPaneId: pane.id,
          focusArea: "terminal",
          panelHidden: false,
          lastInteracted: Date.now(),
        };
      });
      spawn(get().projects[projectId], pane);
      return pane.id;
    },

    closePane(projectId, paneId) {
      terminals.dispose(paneId);
      removePanes(projectId, [paneId]);
    },

    closeTerminalTab(projectId, tabId) {
      const tab = get().projects[projectId]?.terminalTabs.find((t) => t.id === tabId);
      if (!tab) return;
      const ids = paneIds(tab.layout);
      ids.forEach((id) => terminals.dispose(id));
      removePanes(projectId, ids);
    },

    setActiveTerminalTab(projectId, tabId) {
      const p = get().projects[projectId];
      const tab = p?.terminalTabs.find((t) => t.id === tabId);
      if (!p || !tab) return;
      const ids = paneIds(tab.layout);
      const focusedPaneId = p.focusedPaneId && ids.includes(p.focusedPaneId) ? p.focusedPaneId : ids[0];
      patchProject(projectId, (pr) => ({ ...pr, activeTerminalTabId: tabId, focusedPaneId, focusArea: "terminal", panelHidden: false, lastInteracted: Date.now() }));
      ids.forEach((id) => get().markSeen(id));
      requestAnimationFrame(() => terminals.focus(focusedPaneId));
    },

    moveTerminalTab(projectId, tabId, toIndex) {
      patchProject(projectId, (p) => {
        const tab = p.terminalTabs.find((t) => t.id === tabId);
        if (!tab) return p;
        const tabs = p.terminalTabs.filter((t) => t.id !== tabId);
        tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
        return { ...p, terminalTabs: tabs };
      });
    },

    movePaneToNewTab(projectId, paneId) {
      patchProject(projectId, (p) => {
        const src = tabOfPane(p, paneId);
        if (!src || paneIds(src.layout).length < 2) return p;
        const tab: TerminalTab = { id: uid(), layout: { type: "terminal", paneId } };
        const tabs: TerminalTab[] = [];
        for (const t of p.terminalTabs) {
          if (t.id !== src.id) tabs.push(t);
          else {
            tabs.push({ ...t, layout: removePane(t.layout, paneId)! });
            tabs.push(tab);
          }
        }
        return { ...p, terminalTabs: tabs, activeTerminalTabId: tab.id, focusedPaneId: paneId, focusArea: "terminal" };
      });
    },

    focusPane(projectId, paneId) {
      const p = get().projects[projectId];
      if (!p) return;
      const tab = tabOfPane(p, paneId);
      if (!tab) return;
      if (p.focusedPaneId !== paneId || p.activeTerminalTabId !== tab.id || p.focusArea !== "terminal" || p.panelHidden) {
        patchProject(projectId, (pr) => ({
          ...pr,
          focusedPaneId: paneId,
          activeTerminalTabId: tab.id,
          focusArea: "terminal",
          panelHidden: false,
          lastInteracted: Date.now(),
        }));
      }
      get().markSeen(paneId);
    },

    focusAdjacent(delta) {
      const { activeProjectId, projects } = get();
      const p = activeProjectId ? projects[activeProjectId] : null;
      const tab = p?.terminalTabs.find((t) => t.id === p.activeTerminalTabId);
      if (!p || !tab) return;
      const ids = paneIds(tab.layout);
      const i = Math.max(0, ids.indexOf(p.focusedPaneId ?? ""));
      const next = ids[(i + delta + ids.length) % ids.length];
      get().focusPane(p.id, next);
      terminals.focus(next);
    },

    cycleTab(delta) {
      const { activeProjectId, projects } = get();
      const p = activeProjectId ? projects[activeProjectId] : null;
      if (!p) return;
      if (p.focusArea === "editor") {
        const g = p.editorGroups.find((x) => x.id === p.activeEditorGroupId);
        if (!g || !g.tabs.length) return;
        const i = Math.max(0, g.tabs.findIndex((t) => t.id === g.activeTabId));
        get().setActiveEditorTab(p.id, g.id, g.tabs[(i + delta + g.tabs.length) % g.tabs.length].id);
      } else {
        const tabs = p.terminalTabs;
        if (!tabs.length) return;
        const i = Math.max(0, tabs.findIndex((t) => t.id === p.activeTerminalTabId));
        get().setActiveTerminalTab(p.id, tabs[(i + delta + tabs.length) % tabs.length].id);
      }
    },

    restartPane(paneId, command) {
      const found = findPane(get(), paneId);
      if (!found) return;
      const [project, pane] = found;
      patchProject(project.id, (p) => ({ ...p, panes: { ...p.panes, [paneId]: { ...pane, exited: false, exitCode: null } } }));
      dropStatuses([paneId]);
      const run = command !== undefined ? { ...pane, startupCommand: command } : pane;
      const env = paneEnv(get().profiles, project, run);
      recordConfigDir(paneId, env, true);
      terminals.respawn(withSessionTracking(withClaudeModel(project, run)), env);
    },

    resizeSplit(projectId, splitId, sizes) {
      patchProject(projectId, (p) => ({ ...p, terminalTabs: p.terminalTabs.map((t) => ({ ...t, layout: setSizes(t.layout, splitId, sizes) })) }));
    },

    // ---------------- editors ----------------

    openEditor(projectId, path, opts = {}) {
      const p = get().projects[projectId];
      if (!p) return;
      const diff = opts.diff ?? null;
      const preview = !!opts.preview;
      // Already open somewhere? Just reveal it (and pin on a "real" open).
      for (const g of p.editorGroups) {
        const t = g.tabs.find((x) => x.path === path && sameDiff(x.diff, diff));
        if (t) {
          patchProject(projectId, (pr) => ({
            ...pr,
            editorGroups: pr.editorGroups.map((gg) =>
              gg.id !== g.id ? gg : { ...gg, activeTabId: t.id, tabs: preview ? gg.tabs : gg.tabs.map((x) => (x.id === t.id ? { ...x, preview: false } : x)) },
            ),
            activeEditorGroupId: g.id,
            focusArea: "editor",
            panelMaximized: false,
          }));
          return;
        }
      }
      const tab: EditorTab = { id: uid(), path, preview, diff, ...(opts.kind ? { kind: opts.kind } : {}) };
      patchProject(projectId, (pr) => {
        let groups = pr.editorGroups;
        let sizes = pr.editorGroupSizes;
        let group = groups.find((g) => g.id === (opts.groupId ?? pr.activeEditorGroupId)) ?? groups[0];
        if (!group) {
          group = { id: uid(), tabs: [], activeTabId: null };
          groups = [group];
          sizes = [100];
        }
        const dirty = get().dirtyEditors;
        const previewIdx = group.tabs.findIndex((t) => t.preview && !dirty[t.id]);
        const tabs = [...group.tabs];
        if (previewIdx >= 0) tabs[previewIdx] = tab;
        else {
          const activeIdx = tabs.findIndex((t) => t.id === group!.activeTabId);
          tabs.splice(activeIdx >= 0 ? activeIdx + 1 : tabs.length, 0, tab);
        }
        const gid = group.id;
        return {
          ...pr,
          editorGroups: groups.map((g) => (g.id === gid ? { ...g, tabs, activeTabId: tab.id } : g)),
          editorGroupSizes: sizes,
          activeEditorGroupId: gid,
          focusArea: "editor",
          panelMaximized: false,
        };
      });
    },

    closeEditorTab(projectId, tabId) {
      const p = get().projects[projectId];
      const found = p && findEditorTab(p, tabId);
      if (!p || !found) return;
      const [group] = found;
      patchProject(projectId, (pr) => {
        const groups = pr.editorGroups.map((g) => {
          if (g.id !== group.id) return g;
          const idx = g.tabs.findIndex((t) => t.id === tabId);
          const tabs = g.tabs.filter((t) => t.id !== tabId);
          const activeTabId = g.activeTabId === tabId ? tabs[Math.min(idx, tabs.length - 1)]?.id ?? null : g.activeTabId;
          return { ...g, tabs, activeTabId };
        });
        return normalizeGroups({ ...pr, editorGroups: groups });
      });
      set((s) => {
        if (!(tabId in s.dirtyEditors)) return s;
        const dirtyEditors = { ...s.dirtyEditors };
        delete dirtyEditors[tabId];
        return { dirtyEditors };
      });
      const after = get().projects[projectId];
      if (after && after.focusArea === "terminal" && after.focusedPaneId) {
        const id = after.focusedPaneId;
        requestAnimationFrame(() => terminals.focus(id));
      }
    },

    setActiveEditorTab(projectId, groupId, tabId) {
      patchProject(projectId, (p) => ({
        ...p,
        editorGroups: p.editorGroups.map((g) => (g.id === groupId ? { ...g, activeTabId: tabId } : g)),
        activeEditorGroupId: groupId,
        focusArea: "editor",
      }));
    },

    pinEditorTab(projectId, tabId) {
      patchProject(projectId, (p) => ({
        ...p,
        editorGroups: p.editorGroups.map((g) => (g.tabs.some((t) => t.id === tabId && t.preview) ? { ...g, tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t)) } : g)),
      }));
    },

    setEditorTabPath(projectId, tabId, path) {
      const p = get().projects[projectId];
      const found = p && findEditorTab(p, tabId);
      if (!found || found[1].path === path) return;
      patchProject(projectId, (pr) => ({
        ...pr,
        editorGroups: pr.editorGroups.map((g) => (g.tabs.some((t) => t.id === tabId) ? { ...g, tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, path } : t)) } : g)),
      }));
    },

    moveEditorTab(projectId, tabId, toGroupId, toIndex, anchorGroupId) {
      patchProject(projectId, (p) => {
        const found = findEditorTab(p, tabId);
        if (!found) return p;
        const [src, tab] = found;
        let groups = [...p.editorGroups];
        let sizes = [...p.editorGroupSizes];
        let targetId = toGroupId;
        if (targetId === "new") {
          const anchor = anchorGroupId ?? src.id;
          if ((anchor === src.id && src.tabs.length === 1) || groups.length >= MAX_EDITOR_GROUPS) return p;
          const g: EditorGroup = { id: uid(), tabs: [], activeTabId: null };
          const at = groups.findIndex((x) => x.id === anchor) + 1;
          groups.splice(at, 0, g);
          sizes = equal(groups.length);
          targetId = g.id;
        }
        const moved = { ...tab, preview: false };
        groups = groups.map((g) => {
          let tabs = g.tabs;
          let activeTabId = g.activeTabId;
          if (g.id === src.id) {
            const idx = tabs.findIndex((t) => t.id === tabId);
            tabs = tabs.filter((t) => t.id !== tabId);
            if (activeTabId === tabId) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
          }
          if (g.id === targetId) {
            tabs = [...tabs];
            tabs.splice(toIndex ?? tabs.length, 0, moved);
            activeTabId = tabId;
          }
          return { ...g, tabs, activeTabId };
        });
        return normalizeGroups({ ...p, editorGroups: groups, editorGroupSizes: sizes, activeEditorGroupId: targetId, focusArea: "editor" });
      });
    },

    focusEditorGroup(projectId, groupId) {
      const p = get().projects[projectId];
      if (!p || (p.activeEditorGroupId === groupId && p.focusArea === "editor")) return;
      patchProject(projectId, (pr) => ({ ...pr, activeEditorGroupId: groupId, focusArea: "editor" }));
    },

    resizeEditorGroups(projectId, sizes) {
      patchProject(projectId, (p) => ({ ...p, editorGroupSizes: sizes }));
    },

    setEditorDirty(tabId, dirty) {
      if (!!get().dirtyEditors[tabId] === dirty) return;
      set((s) => ({ dirtyEditors: { ...s.dirtyEditors, [tabId]: dirty } }));
      if (dirty) {
        // Editing a preview tab pins it (VS Code behaviour).
        for (const p of Object.values(get().projects)) if (findEditorTab(p, tabId)) get().pinEditorTab(p.id, tabId);
      }
    },

    // ---------------- workbench layout ----------------

    setFocusArea(projectId, area) {
      const p = get().projects[projectId];
      if (p && p.focusArea !== area) patchProject(projectId, (pr) => ({ ...pr, focusArea: area }));
    },

    setPanelPosition(projectId, pos) {
      patchProject(projectId, (p) => ({ ...p, panelPosition: pos, panelHidden: false }));
      set({ defaultPanelPosition: pos });
      api.settingSet("panelPosition", pos).catch(() => {});
    },

    setPanelSize(projectId, size) {
      patchProject(projectId, (p) => ({ ...p, panelSize: Math.max(10, Math.min(90, size)) }));
    },

    togglePanelMaximized(projectId) {
      patchProject(projectId, (p) => ({ ...p, panelMaximized: !p.panelMaximized, panelHidden: false }));
    },

    togglePanel(projectId) {
      const p = get().projects[projectId];
      if (!p) return;
      const hide = !p.panelHidden && hasEditors(p);
      patchProject(projectId, (pr) => ({ ...pr, panelHidden: hide, panelMaximized: false, focusArea: hide ? "editor" : "terminal" }));
      if (!hide && p.focusedPaneId) {
        const id = p.focusedPaneId;
        requestAnimationFrame(() => terminals.focus(id));
      }
    },

    // ---------------- runtime events ----------------

    markActivity(paneId) {
      const now = Date.now();
      if (now - (activityThrottle.get(paneId) ?? 0) < 3000) return;
      activityThrottle.set(paneId, now);
      const found = findPane(get(), paneId);
      if (!found) return;
      const [project, pane] = found;
      patchProject(project.id, (p) => ({
        ...p,
        lastInteracted: Math.max(p.lastInteracted, now),
        panes: { ...p.panes, [paneId]: { ...pane, lastActivity: now } },
      }));
    },

    setPaneSession(paneId, sessionId) {
      const found = findPane(get(), paneId);
      if (!found || found[1].sessionId === sessionId) return;
      const [project, pane] = found;
      patchProject(project.id, (p) => ({ ...p, panes: { ...p.panes, [paneId]: { ...pane, sessionId } } }));
    },

    setPaneTitle(paneId, title) {
      const found = findPane(get(), paneId);
      if (!found || found[1].title === title) return;
      const [project, pane] = found;
      // Claude Code sets titles like "✳ Fix login bug": auto-detect Claude panes.
      const isClaude = pane.isClaude || /claude/i.test(title) || /^[✳✻✽✶✢·*]\s/.test(title);
      patchProject(project.id, (p) => ({ ...p, panes: { ...p.panes, [paneId]: { ...pane, title, isClaude } } }));
    },

    setProgramStatus(paneId, st) {
      const found = findPane(get(), paneId);
      if (st.state === "clear") {
        dropStatuses([paneId]);
        return;
      }
      const known: SessionState[] = ["idle", "working", "blocked", "done", "error"];
      const state = (known.includes(st.state as SessionState) ? st.state : "unknown") as SessionState;
      const visible = isPaneVisible(get(), paneId);
      set((prev) => ({
        statuses: {
          ...prev.statuses,
          [paneId]: { state, kind: st.kind, progress: st.progress, title: st.title, msg: st.msg, seen: visible, at: Date.now() },
        },
      }));
      if (found) {
        const [project, pane] = found;
        if (!pane.isClaude && st.app === "claude-code") {
          patchProject(project.id, (p) => ({ ...p, panes: { ...p.panes, [paneId]: { ...pane, isClaude: true } } }));
        }
      }
    },

    markSeen(paneId) {
      const st = get().statuses[paneId];
      if (st && !st.seen) set((s) => ({ statuses: { ...s.statuses, [paneId]: { ...st, seen: true } } }));
    },

    setExited(paneId, code) {
      const found = findPane(get(), paneId);
      if (!found) return;
      const [project, pane] = found;
      patchProject(project.id, (p) => ({ ...p, panes: { ...p.panes, [paneId]: { ...pane, exited: true, exitCode: code } } }));
      set((s) => ({ statuses: { ...s.statuses, [paneId]: { state: "exited", seen: true, at: Date.now() } } }));
      useAccounts.getState().onPaneExit(project.id, paneId, code);
    },

    setGitStatus(projectId, st) {
      set((s) => ({ gitStatus: { ...s.gitStatus, [projectId]: st } }));
    },

    setModal(modal) {
      set({ modal });
    },
    setShowInactive(showInactive) {
      set({ showInactive });
    },

    async loadProfiles() {
      try {
        set({ profiles: await api.profilesList() });
      } catch {
        /* backend not ready */
      }
    },

    async restore() {
      await get().loadProfiles();
      await useAccounts.getState().load(); // the active account's env applies to restored panes
      try {
        const pos = await api.settingGet("panelPosition");
        if (pos === "bottom" || pos === "top" || pos === "left" || pos === "right") set({ defaultPanelPosition: pos });
        const raw = await api.settingGet("workspace");
        if (raw) {
          const snap = JSON.parse(raw) as Snapshot;
          const projects: Record<string, Project> = {};
          for (const p of snap.projects) {
            const migrated = migrateProject(p, get().defaultPanelPosition);
            if (migrated) projects[migrated.id] = migrated;
          }
          const order = snap.order.filter((id) => projects[id]);
          set({ projects, order, activeProjectId: snap.activeProjectId && projects[snap.activeProjectId] ? snap.activeProjectId : order[0] ?? null });
          for (const id of order) {
            const p = projects[id];
            api.fsWatch(p.rootPath).catch(() => {});
            let continued = false;
            for (const pane of Object.values(p.panes)) {
              // Each Claude pane resumes its own recorded conversation. Panes without one
              // resume the directory's latest conversation, once per project (two panes
              // continuing the same conversation would conflict).
              let restored = pane;
              const claudeCmd = pane.isClaude && (pane.startupCommand === CLAUDE_CMD || /^claude --(resume|continue)\b/.test(pane.startupCommand ?? ""));
              if (claudeCmd && isSessionId(pane.sessionId)) {
                restored = { ...pane, startupCommand: resumeCommand(pane.sessionId) };
              } else if (pane.isClaude && pane.startupCommand === CLAUDE_CMD && !continued) {
                restored = { ...pane, startupCommand: `${CLAUDE_CMD} --continue` };
                continued = true;
              }
              spawn(p, restored);
            }
          }
        }
      } catch (err) {
        console.error("restore failed", err);
      }
      set({ loaded: true });
    },
  };
});

/** Bring a persisted project (v1 with `layout`, or v2) up to the current shape. */
function migrateProject(raw: Project & { layout?: unknown }, defaultPos: PanelPosition): Project | null {
  const panes: Record<string, Pane> = {};
  for (const pane of Object.values(raw.panes ?? {})) panes[pane.id] = { ...pane, exited: false, exitCode: null };
  const has = (id: string) => !!panes[id];
  let tabs: TerminalTab[] = (raw.terminalTabs ?? [])
    .map((t) => ({ id: t.id, layout: sanitize(t.layout, has) }))
    .filter((t): t is TerminalTab => !!t.layout);
  if (!raw.terminalTabs && raw.layout) {
    const layout = sanitize(raw.layout, has);
    if (layout) tabs = [{ id: uid(), layout }];
  }
  // Drop panes no tab references.
  const used = new Set(tabs.flatMap((t) => paneIds(t.layout)));
  for (const id of Object.keys(panes)) if (!used.has(id)) delete panes[id];
  const groups = (raw.editorGroups ?? [])
    .map((g) => ({ ...g, tabs: g.tabs.filter((t) => t && t.path) }))
    .filter((g) => g.tabs.length)
    .map((g) => ({ ...g, activeTabId: g.tabs.some((t) => t.id === g.activeTabId) ? g.activeTabId : g.tabs[0].id }));
  if (!tabs.length && !groups.length) return null;
  const active = tabs.find((t) => t.id === raw.activeTerminalTabId) ?? tabs[0];
  const activeIds = active ? paneIds(active.layout) : [];
  const sizes = raw.editorGroupSizes?.length === groups.length ? raw.editorGroupSizes : equal(groups.length);
  const { layout: _legacy, ...rest } = raw;
  return {
    ...rest,
    panes,
    terminalTabs: tabs,
    activeTerminalTabId: active?.id ?? null,
    focusedPaneId: raw.focusedPaneId && activeIds.includes(raw.focusedPaneId) ? raw.focusedPaneId : activeIds[0] ?? null,
    editorGroups: groups,
    editorGroupSizes: sizes,
    activeEditorGroupId: groups.some((g) => g.id === raw.activeEditorGroupId) ? raw.activeEditorGroupId : groups[0]?.id ?? null,
    focusArea: raw.focusArea === "editor" && groups.length ? "editor" : tabs.length ? "terminal" : "editor",
    panelPosition: raw.panelPosition ?? defaultPos,
    panelSize: raw.panelSize ?? 40,
    panelMaximized: !!raw.panelMaximized,
    panelHidden: !!raw.panelHidden && groups.length > 0,
    sidebarOpen: raw.sidebarOpen ?? true,
    sidebarTab: raw.sidebarTab ?? "files",
    sidebarWidth: raw.sidebarWidth ?? 260,
  };
}

interface Snapshot {
  version: 1 | 2;
  order: string[];
  activeProjectId: string | null;
  projects: (Project & { layout?: unknown })[];
}

// ---- persistence (debounced) ----
let saveTimer: number | undefined;
useWorkspace.subscribe((s, prev) => {
  if (!s.loaded) return;
  if (s.projects === prev.projects && s.order === prev.order && s.activeProjectId === prev.activeProjectId) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const st = useWorkspace.getState();
    const snap: Snapshot = {
      version: 2,
      order: st.order,
      activeProjectId: st.activeProjectId,
      projects: st.order.map((id) => {
        const p = st.projects[id];
        const panes = Object.fromEntries(Object.entries(p.panes).filter(([, pane]) => !pane.ephemeral));
        return { ...p, panes }; // layouts referencing dropped panes are cleaned on restore
      }),
    };
    api.settingSet("workspace", JSON.stringify(snap)).catch(() => {});
  }, 600);
});
