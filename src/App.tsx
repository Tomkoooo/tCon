import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkspace } from "./store/workspace";
import { notifyPaneStatus } from "./notify";
import { scheduleGitRefresh } from "./store/gitRefresh";
import { installFocusRefresh, onRefresh } from "./refresh";
import type { FsChangedEvent, ProgramStatus } from "./types";
import { TabBar } from "./components/TabBar";
import { ProjectView } from "./components/ProjectView";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProfilesModal } from "./components/ProfilesModal";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { StatusBar } from "./components/StatusBar";
import { TasksHost } from "./components/tasks/TasksHost";
import { useBackgroundBridge } from "./background/bridge";
import { useTheming } from "./theming/store";
import { COMMAND_MAP, effectiveBindings, resolveKey } from "./commands";
import { UpdateNotice } from "./components/UpdateNotice";
import { startUpdateChecks } from "./updater";

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
        if (next !== prev && (next === "blocked" || next === "done" || next === "error")) void notifyPaneStatus(payload.paneId, payload.status);
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
    const offRefresh = onRefresh(null, () => {
      for (const p of Object.values(useWorkspace.getState().projects)) scheduleGitRefresh(p.id, 0);
    });
    const offFocus = installFocusRefresh();
    return () => {
      unsubs.forEach((u) => u.then((f) => f()));
      offRefresh();
      offFocus();
    };
  }, []);
}

// ---------- git status ----------
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
// ---------- keyboard shortcuts (keybindings.json + defaults, see commands.ts) ----------
function useShortcuts() {
  const userBindings = useTheming((s) => s.keybindings);
  useEffect(() => {
    const bindings = effectiveBindings(userBindings);
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey && !(e.altKey && e.key.length > 1)) return; // plain typing never hits a binding
      const b = resolveKey(e, bindings);
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      COMMAND_MAP.get(b.command)?.run(b.args);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [userBindings]);
}

export default function App() {
  const loaded = useWorkspace((s) => s.loaded);
  const project = useWorkspace((s) => (s.activeProjectId ? s.projects[s.activeProjectId] : null));
  const modal = useWorkspace((s) => s.modal);
  const setModal = useWorkspace((s) => s.setModal);

  useEffect(() => {
    void useTheming.getState().init();
    void useWorkspace.getState().restore();
  }, []);
  useBackendEvents();
  useGitPolling();
  useDockBadge();
  useBackgroundBridge();
  useShortcuts();
  useEffect(startUpdateChecks, []);

  return (
    <div className="app">
      <TabBar />
      <div className="app-body">
        {project ? (
          <ProjectView key={project.id} project={project} />
        ) : (
          loaded && (
            <div className="empty-state">
              <div>No project open</div>
              <button className="btn primary" onClick={() => setModal({ kind: "newProject" })}>
                Open project <span className="kbd">⌘T</span>
              </button>
            </div>
          )
        )}
      </div>
      <StatusBar />
      <TasksHost />
      <UpdateNotice />
      {modal?.kind === "newProject" && <NewProjectModal />}
      {modal?.kind === "profiles" && <ProfilesModal />}
      {modal?.kind === "projectSettings" && <ProjectSettingsModal projectId={modal.projectId} />}
    </div>
  );
}
