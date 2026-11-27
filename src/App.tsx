import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { api } from "./api";
import { findPane, useWorkspace } from "./store/workspace";
import { terminals } from "./terminal/registry";
import type { FsChangedEvent, ProgramStatus } from "./types";
import { TabBar } from "./components/TabBar";
import { ProjectView } from "./components/ProjectView";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProfilesModal } from "./components/ProfilesModal";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { StatusBar } from "./components/StatusBar";

// ---------- backend events ----------
function useBackendEvents() {
  useEffect(() => {
    const unsubs: Promise<() => void>[] = [];
    unsubs.push(
      listen<{ paneId: string; status: ProgramStatus }>("pane-status", ({ payload }) => {
        const st = useWorkspace.getState();
        const prev = st.statuses[payload.paneId]?.state;
        st.setProgramStatus(payload.paneId, payload.status);
        const next = payload.status.state;
        if (next !== prev && (next === "blocked" || next === "done" || next === "error")) void notify(payload.paneId, payload.status);
      }),
    );
    unsubs.push(
      listen<{ paneId: string; code: number | null }>("pane-exit", ({ payload }) => useWorkspace.getState().setExited(payload.paneId, payload.code)),
    );
    unsubs.push(
      listen<FsChangedEvent>("fs-changed", ({ payload }) => {
        for (const p of Object.values(useWorkspace.getState().projects)) if (p.rootPath === payload.root) scheduleGitRefresh(p.id);
      }),
    );
    return () => unsubs.forEach((u) => u.then((f) => f()));
  }, []);
}

async function notify(paneId: string, status: ProgramStatus) {
  const st = useWorkspace.getState();
  const found = findPane(st, paneId);
  if (!found) return;
  const [project, pane] = found;
  const visible = document.hasFocus() && st.activeProjectId === project.id && project.focusedPaneId === paneId;
  if (visible) return;
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (!ok) return;
    const what = status.state === "blocked" ? `needs you${status.kind ? ` (${status.kind})` : ""}` : status.state === "done" ? "is done" : "hit an error";
    sendNotification({ title: `${project.name} · ${status.title || pane.title} ${what}`, body: status.msg || project.rootPath });
  } catch {
    /* notifications unavailable */
  }
}

// ---------- git status ----------
const gitTimers = new Map<string, number>();
function scheduleGitRefresh(projectId: string, delay = 400) {
  window.clearTimeout(gitTimers.get(projectId));
  gitTimers.set(
    projectId,
    window.setTimeout(async () => {
      const p = useWorkspace.getState().projects[projectId];
      if (!p) return;
      try {
        useWorkspace.getState().setGitStatus(projectId, await api.gitStatus(p.rootPath));
      } catch {
        useWorkspace.getState().setGitStatus(projectId, null);
      }
    }, delay),
  );
}

function useGitPolling() {
  const order = useWorkspace((s) => s.order);
  const active = useWorkspace((s) => s.activeProjectId);
  useEffect(() => {
    order.forEach((id, i) => scheduleGitRefresh(id, 100 + i * 50));
  }, [order]);
  useEffect(() => {
    if (!active) return;
    scheduleGitRefresh(active, 50);
    const t = window.setInterval(() => scheduleGitRefresh(active, 0), 15_000);
    const onFocus = () => scheduleGitRefresh(active, 0);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [active]);
}

// ---------- dock badge = sessions waiting for you ----------
function useDockBadge() {
  const blocked = useWorkspace((s) => Object.values(s.statuses).filter((x) => x.state === "blocked").length);
  useEffect(() => {
    getCurrentWindow().setBadgeCount(blocked > 0 ? blocked : undefined).catch(() => {});
  }, [blocked]);
}

// ---------- theme ----------
function useTheme() {
  const theme = useWorkspace((s) => s.theme);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    requestAnimationFrame(() => terminals.applyTheme());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => terminals.applyTheme();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
}

// ---------- keyboard shortcuts ----------
export function jumpToAttention() {
  const st = useWorkspace.getState();
  const candidates: [string, string, number][] = [];
  for (const id of st.order) {
    const p = st.projects[id];
    for (const paneId of Object.keys(p.panes)) {
      const s = st.statuses[paneId];
      if (s && (s.state === "blocked" || (s.state === "done" && !s.seen) || (s.state === "error" && !s.seen)))
        candidates.push([id, paneId, s.state === "blocked" ? 0 : 1]);
    }
  }
  candidates.sort((a, b) => a[2] - b[2]);
  const target = candidates[0];
  if (!target) return;
  st.setActive(target[0]);
  st.focusPane(target[0], target[1]);
  requestAnimationFrame(() => terminals.focus(target[1]));
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey) return;
      const st = useWorkspace.getState();
      const project = st.activeProjectId ? st.projects[st.activeProjectId] : null;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (k === "t" && !e.shiftKey) return run(() => st.setModal({ kind: "newProject" }));
      if (k === "," ) return run(() => st.setModal({ kind: "profiles" }));
      if (k === "j") return run(jumpToAttention);
      if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
        const id = e.key === "9" ? st.order[st.order.length - 1] : st.order[Number(e.key) - 1];
        return id ? run(() => st.setActive(id)) : undefined;
      }
      if (e.shiftKey && (e.key === "[" || e.key === "{")) return run(() => st.cycleProject(-1));
      if (e.shiftKey && (e.key === "]" || e.key === "}")) return run(() => st.cycleProject(1));
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowUp")) return run(() => st.focusAdjacent(-1));
      if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowDown")) return run(() => st.focusAdjacent(1));
      if (!project) return;
      if (k === "d") return run(() => st.addPane(project.id, { claude: false, direction: e.shiftKey ? "column" : "row" }));
      if (k === "c" && e.shiftKey) return run(() => st.addPane(project.id, { claude: true, direction: "row" }));
      if (k === "w" && !e.shiftKey) return run(() => project.focusedPaneId && st.closeLeaf(project.id, project.focusedPaneId));
      if (k === "b") return run(() => st.updateProject(project.id, { sidebarOpen: !project.sidebarOpen }));
      if (k === "g" && e.shiftKey)
        return run(() => st.updateProject(project.id, { sidebarOpen: !(project.sidebarOpen && project.sidebarTab === "git"), sidebarTab: "git" }));
      if (k === "e" && e.shiftKey)
        return run(() => st.updateProject(project.id, { sidebarOpen: !(project.sidebarOpen && project.sidebarTab === "files"), sidebarTab: "files" }));
      if (k === "k") return run(() => project.focusedPaneId && terminals.clear(project.focusedPaneId));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export default function App() {
  const loaded = useWorkspace((s) => s.loaded);
  const project = useWorkspace((s) => (s.activeProjectId ? s.projects[s.activeProjectId] : null));
  const modal = useWorkspace((s) => s.modal);
  const setModal = useWorkspace((s) => s.setModal);

  useEffect(() => {
    void useWorkspace.getState().restore();
  }, []);
  useBackendEvents();
  useGitPolling();
  useDockBadge();
  useTheme();
  useShortcuts();

  return (
    <div className="app">
      <TabBar />
      <div className="app-body">
        {project ? (
          <ProjectView key={project.id} project={project} />
        ) : (
          loaded && (
            <div className="empty-state">
              <div style={{ fontSize: 22, color: "var(--fg)" }}>tCon</div>
              <div>Projects + terminals for parallel Claude Code sessions</div>
              <button className="btn primary" onClick={() => setModal({ kind: "newProject" })}>
                Open a project <span className="kbd" style={{ marginLeft: 6 }}>⌘T</span>
              </button>
            </div>
          )
        )}
      </div>
      <StatusBar />
      {modal?.kind === "newProject" && <NewProjectModal />}
      {modal?.kind === "profiles" && <ProfilesModal />}
      {modal?.kind === "projectSettings" && <ProjectSettingsModal projectId={modal.projectId} />}
    </div>
  );
}
