// Polls the session ids recorded by the SessionStart hook (claudeSessions.ts) into the panes,
// and forgets the records of closed panes. Installed once by App.
import { sessionsApi } from "./claudeSessions";
import { useWorkspace } from "./store/workspace";

function claudePaneIds(): string[] {
  const ids: string[] = [];
  for (const p of Object.values(useWorkspace.getState().projects)) {
    for (const pane of Object.values(p.panes)) if (pane.isClaude && !pane.exited) ids.push(pane.id);
  }
  return ids;
}

async function sync() {
  const ids = claudePaneIds();
  if (!ids.length) return;
  try {
    const found = await sessionsApi.forPanes(ids);
    const ws = useWorkspace.getState();
    for (const [paneId, sid] of Object.entries(found)) ws.setPaneSession(paneId, sid);
  } catch {
    /* backend unavailable */
  }
}

export function installSessionTracker(): () => void {
  let timer: number | undefined;
  const soon = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void sync(), 1500);
  };
  const interval = window.setInterval(() => void sync(), 20_000);
  let known = new Set(Object.values(useWorkspace.getState().projects).flatMap((p) => Object.keys(p.panes)));
  const off = useWorkspace.subscribe((s, prev) => {
    // A Claude session started, cleared or resumed: its status changes right after.
    if (s.statuses !== prev.statuses) soon();
    if (s.projects !== prev.projects && s.loaded) {
      const now = new Set(Object.values(s.projects).flatMap((p) => Object.keys(p.panes)));
      const gone = [...known].filter((id) => !now.has(id));
      known = now;
      if (gone.length) void sessionsApi.forget(gone).catch(() => {});
    }
  });
  soon();
  return () => {
    off();
    window.clearInterval(interval);
    window.clearTimeout(timer);
  };
}
