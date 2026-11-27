import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { findPane, isPaneVisible, useWorkspace } from "./store/workspace";
import { scheduleGitRefresh } from "./store/gitRefresh";
import { installFocusRefresh, onRefresh } from "./refresh";
import type { FsChangedEvent, ProgramStatus } from "./types";
import { TabBar } from "./components/TabBar";
import { ProjectView } from "./components/ProjectView";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProfilesModal } from "./components/ProfilesModal";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { StatusBar } from "./components/StatusBar";
import { useTheming } from "./theming/store";
import { COMMAND_MAP, effectiveBindings, resolveKey } from "./commands";

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

async function notify(paneId: string, status: ProgramStatus) {
  const st = useWorkspace.getState();
  const found = findPane(st, paneId);
  if (!found) return;
  const [project, pane] = found;
  if (isPaneVisible(st, paneId)) return;
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
