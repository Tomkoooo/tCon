import { create } from "zustand";
import { api } from "../api";
import type { GitStatus, LayoutNode, Pane, PaneStatus, ProgramStatus, Profile, Project, SessionState } from "../types";
import { insertLeaf, leafKey, leaves, removeLeaf, replaceLeaf, setSizes, uid } from "./layout";
import { terminals } from "../terminal/registry";

export const PALETTE = ["#6aa7ff", "#5fc48a", "#e5b450", "#ef5f5f", "#b884f0", "#4fc6c6", "#f08a4b", "#e57ab8", "#9aa3ad"];
export const INACTIVE_AFTER_MS = 30 * 60 * 1000;
const CLAUDE_CMD = "claude";

export type Modal =
  | null
  | { kind: "newProject" }
  | { kind: "profiles" }
  | { kind: "projectSettings"; projectId: string };

export interface OpenProjectArgs {
  path: string;
  name?: string;
  color?: string;
  profileId?: string | null;
  claude: boolean;
}

interface WorkspaceState {
  loaded: boolean;
  projects: Record<string, Project>;
  order: string[];
  activeProjectId: string | null;
  statuses: Record<string, PaneStatus>;
  gitStatus: Record<string, GitStatus | null>;
  profiles: Profile[];
  modal: Modal;
  showInactive: boolean;
  theme: "system" | "dark" | "light";

  // projects
  openProject(args: OpenProjectArgs): string;
  closeProject(id: string): void;
  setActive(id: string): void;
  cycleProject(delta: number): void;
  updateProject(id: string, patch: Partial<Pick<Project, "name" | "color" | "profileId" | "accountLabel" | "sidebarOpen" | "sidebarTab">>): void;
  moveProject(id: string, toIndex: number): void;

  // panes
  addPane(projectId: string, opts: { claude: boolean; direction?: "row" | "column"; command?: string }): string;
  closePane(projectId: string, paneId: string): void;
  focusPane(projectId: string, key: string): void;
  focusAdjacent(delta: number): void;
  restartPane(paneId: string): void;
  openEditor(projectId: string, path: string, diff?: { file: string | null; staged: boolean }): void;
  closeLeaf(projectId: string, key: string): void;
  resizeSplit(projectId: string, splitId: string, sizes: number[]): void;

  // runtime events
  markActivity(paneId: string): void;
  setPaneTitle(paneId: string, title: string): void;
  setProgramStatus(paneId: string, st: ProgramStatus): void;
  markSeen(paneId: string): void;
  setExited(paneId: string, code: number | null): void;
  setGitStatus(projectId: string, st: GitStatus | null): void;

  // misc
  setModal(m: Modal): void;
  setShowInactive(v: boolean): void;
  setTheme(t: "system" | "dark" | "light"): void;
  loadProfiles(): Promise<void>;
  restore(): Promise<void>;
}

/** Editor leaves store diff info in a side map (not persisted). */
export const editorDiffs = new Map<string, { file: string | null; staged: boolean }>();

export function findPane(s: Pick<WorkspaceState, "projects">, paneId: string): [Project, Pane] | null {
  for (const p of Object.values(s.projects)) if (p.panes[paneId]) return [p, p.panes[paneId]];
  return null;
}

export function profileEnv(profiles: Profile[], profileId?: string | null): Record<string, string> {
  return profiles.find((p) => p.id === profileId)?.env ?? {};
}

const STATE_PRIORITY: SessionState[] = ["blocked", "error", "working", "done", "idle", "exited", "unknown"];

/** Aggregate status of a project = most urgent pane status. */
export function projectStatus(project: Project, statuses: Record<string, PaneStatus>): PaneStatus | null {
  let best: PaneStatus | null = null;
  for (const id of Object.keys(project.panes)) {
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

function nextColor(projects: Record<string, Project>) {
  const used = new Set(Object.values(projects).map((p) => p.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[Object.keys(projects).length % PALETTE.length];
}

function basename(p: string) {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function makePane(cwd: string, claude: boolean, profileId?: string | null, command?: string): Pane {
  return {
    id: uid(),
    title: claude ? "Claude Code" : "shell",
    cwd,
    isClaude: claude,
    startupCommand: command ?? (claude ? CLAUDE_CMD : undefined),
    profileId: profileId ?? null,
    lastActivity: Date.now(),
  };
}

const activityThrottle = new Map<string, number>();

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const patchProject = (id: string, fn: (p: Project) => Project) =>
    set((s) => (s.projects[id] ? { projects: { ...s.projects, [id]: fn(s.projects[id]) } } : s));

  const spawn = (project: Project, pane: Pane) => {
    const env = profileEnv(get().profiles, pane.profileId ?? project.profileId);
    terminals.ensure(pane, env);
  };

  return {
    loaded: false,
    projects: {},
    order: [],
    activeProjectId: null,
    statuses: {},
    gitStatus: {},
    profiles: [],
    modal: null,
    showInactive: false,
    theme: "system",

    openProject({ path, name, color, profileId, claude }) {
      const existing = Object.values(get().projects).find((p) => p.rootPath === path);
      if (existing) {
        get().setActive(existing.id);
        get().addPane(existing.id, { claude, direction: "row" });
        return existing.id;
      }
      const pane = makePane(path, claude, profileId);
      const project: Project = {
        id: uid(),
        name: name || basename(path),
        rootPath: path,
        color: color || nextColor(get().projects),
        profileId: profileId ?? null,
        lastInteracted: Date.now(),
        panes: { [pane.id]: pane },
        layout: { type: "terminal", paneId: pane.id },
        focusedPaneId: pane.id,
        sidebarOpen: false,
        sidebarTab: "files",
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
        const activeProjectId = s.activeProjectId === id ? order[Math.min(idx, order.length - 1)] ?? null : s.activeProjectId;
        return { projects, order, statuses, activeProjectId };
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

    addPane(projectId, { claude, direction = "row", command }) {
      const project = get().projects[projectId];
      if (!project) return "";
      const focused = project.focusedPaneId ? project.panes[project.focusedPaneId] : undefined;
      const pane = makePane(focused?.cwd ?? project.rootPath, claude, project.profileId, command);
      patchProject(projectId, (p) => ({
        ...p,
        panes: { ...p.panes, [pane.id]: pane },
        layout: insertLeaf(p.layout, p.focusedPaneId ?? null, { type: "terminal", paneId: pane.id }, direction),
        focusedPaneId: pane.id,
        lastInteracted: Date.now(),
      }));
      spawn(get().projects[projectId], pane);
      return pane.id;
    },

    closePane(projectId, paneId) {
      terminals.dispose(paneId);
      get().closeLeaf(projectId, paneId);
    },

    closeLeaf(projectId, key) {
      const project = get().projects[projectId];
      if (!project) return;
      if (project.panes[key]) terminals.dispose(key);
      editorDiffs.delete(key);
      const layout = removeLeaf(project.layout, key);
      if (!layout) {
        get().closeProject(projectId);
        return;
      }
      const panes = { ...project.panes };
      delete panes[key];
      const remaining = leaves(layout);
      const focusedPaneId = project.focusedPaneId === key ? leafKey(remaining[remaining.length - 1]) : project.focusedPaneId;
      patchProject(projectId, (p) => ({ ...p, panes, layout, focusedPaneId }));
      set((s) => {
        const statuses = { ...s.statuses };
        delete statuses[key];
        return { statuses };
      });
      if (focusedPaneId) requestAnimationFrame(() => terminals.focus(focusedPaneId));
    },

    focusPane(projectId, key) {
      const p = get().projects[projectId];
      if (!p || p.focusedPaneId === key) {
        if (p) get().markSeen(key);
        return;
      }
      patchProject(projectId, (pr) => ({ ...pr, focusedPaneId: key, lastInteracted: Date.now() }));
      get().markSeen(key);
    },

    focusAdjacent(delta) {
      const { activeProjectId, projects } = get();
      const p = activeProjectId ? projects[activeProjectId] : null;
      if (!p) return;
      const keys = leaves(p.layout).map(leafKey);
      if (!keys.length) return;
      const i = Math.max(0, keys.indexOf(p.focusedPaneId ?? ""));
      const next = keys[(i + delta + keys.length) % keys.length];
      get().focusPane(p.id, next);
      terminals.focus(next);
    },

    restartPane(paneId) {
      const found = findPane(get(), paneId);
      if (!found) return;
      const [project, pane] = found;
      patchProject(project.id, (p) => ({ ...p, panes: { ...p.panes, [paneId]: { ...pane, exited: false, exitCode: null } } }));
      set((s) => {
        const statuses = { ...s.statuses };
        delete statuses[paneId];
        return { statuses };
      });
      terminals.respawn(pane, profileEnv(get().profiles, pane.profileId ?? project.profileId));
    },

    openEditor(projectId, path, diff) {
      const project = get().projects[projectId];
      if (!project) return;
      const existing = leaves(project.layout).find((l) => l.type === "editor");
      const leaf = { type: "editor" as const, path, id: uid() };
      if (diff) editorDiffs.set(leaf.id, diff);
      patchProject(projectId, (p) => {
        let layout: LayoutNode | null;
        if (existing) {
          editorDiffs.delete(leafKey(existing));
          layout = replaceLeaf(p.layout, leafKey(existing), leaf);
        } else {
          layout = insertLeaf(p.layout, null, leaf, "row");
        }
        return { ...p, layout, focusedPaneId: leaf.id };
      });
    },

    resizeSplit(projectId, splitId, sizes) {
      patchProject(projectId, (p) => ({ ...p, layout: setSizes(p.layout, splitId, sizes) }));
    },

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
        set((s) => {
          const statuses = { ...s.statuses };
          delete statuses[paneId];
          return { statuses };
        });
        return;
      }
      const known: SessionState[] = ["idle", "working", "blocked", "done", "error"];
      const state = (known.includes(st.state as SessionState) ? st.state : "unknown") as SessionState;
      const s = get();
      const visible =
        !!found && s.activeProjectId === found[0].id && found[0].focusedPaneId === paneId && document.hasFocus();
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
    setTheme(theme) {
      set({ theme });
      api.settingSet("theme", theme).catch(() => {});
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
      try {
        const theme = await api.settingGet("theme");
        if (theme === "dark" || theme === "light" || theme === "system") set({ theme });
        const raw = await api.settingGet("workspace");
        if (raw) {
          const snap = JSON.parse(raw) as Snapshot;
          const projects: Record<string, Project> = {};
          for (const p of snap.projects) {
            // Restored panes get a fresh start; drop editor leaves whose diff info is gone.
            const panes: Record<string, Pane> = {};
            for (const pane of Object.values(p.panes)) panes[pane.id] = { ...pane, exited: false, exitCode: null };
            if (!p.layout || !Object.keys(panes).length) continue;
            projects[p.id] = { ...p, panes };
          }
          const order = snap.order.filter((id) => projects[id]);
          set({ projects, order, activeProjectId: snap.activeProjectId && projects[snap.activeProjectId] ? snap.activeProjectId : order[0] ?? null });
          for (const id of order) {
            const p = projects[id];
            api.fsWatch(p.rootPath).catch(() => {});
            let continued = false;
            for (const pane of Object.values(p.panes)) {
              // Resume the most recent Claude conversation in this directory (once per project —
              // two panes continuing the same conversation would conflict).
              let restored = pane;
              if (pane.isClaude && pane.startupCommand === CLAUDE_CMD && !continued) {
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

interface Snapshot {
  version: 1;
  order: string[];
  activeProjectId: string | null;
  projects: Project[];
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
      version: 1,
      order: st.order,
      activeProjectId: st.activeProjectId,
      projects: st.order.map((id) => {
        const p = st.projects[id];
        // editor leaves are not restored
        const layout = leaves(p.layout)
          .filter((l) => l.type === "editor")
          .reduce<LayoutNode | null>((acc, l) => removeLeaf(acc, leafKey(l)), p.layout);
        const focused = p.focusedPaneId && p.panes[p.focusedPaneId] ? p.focusedPaneId : Object.keys(p.panes)[0] ?? null;
        return { ...p, layout, focusedPaneId: focused };
      }),
    };
    api.settingSet("workspace", JSON.stringify(snap)).catch(() => {});
  }, 600);
});
