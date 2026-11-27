import { jumpToAttention } from "../commands";
import { useWorkspace } from "../store/workspace";
import { useTheming } from "../theming/store";
import { MODEL_SETTING, modelLabel, normalizeModel } from "../claudeModel";

export function StatusBar() {
  const project = useWorkspace((s) => (s.activeProjectId ? s.projects[s.activeProjectId] : null));
  const git = useWorkspace((s) => (s.activeProjectId ? s.gitStatus[s.activeProjectId] : null));
  const counts = useWorkspace((s) => {
    const c = { working: 0, blocked: 0, done: 0 };
    for (const st of Object.values(s.statuses)) {
      if (st.state === "working") c.working++;
      else if (st.state === "blocked") c.blocked++;
      else if (st.state === "done" && !st.seen) c.done++;
    }
    return `${c.working}/${c.blocked}/${c.done}`;
  });
  const [working, blocked, done] = counts.split("/").map(Number);
  const updateProject = useWorkspace((s) => s.updateProject);
  const setModal = useWorkspace((s) => s.setModal);
  const globalModel = useTheming((s) => normalizeModel(s.settings[MODEL_SETTING]));
  const override = project?.claudeModel ? normalizeModel(project.claudeModel) : null;
  const model = override ?? globalModel;

  return (
    <div className="statusbar">
      {project && (
        <>
          <span className="sb-item path" title={project.rootPath}>{project.rootPath.replace(/^\/Users\/[^/]+/, "~")}</span>
          {git?.isRepo && (
            <button className="sb-item clickable" title="Show git panel (⇧⌘G)" onClick={() => updateProject(project.id, { sidebarOpen: true, sidebarTab: "git" })}>
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden><path d="M5 3v10M5 13a1.8 1.8 0 1 0 0 .01M5 3a1.8 1.8 0 1 0 0 .01M11 5a1.8 1.8 0 1 0 0 .01M11 6.8c0 3-6 2-6 4.4" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
              {git.branch ?? git.head ?? "detached"}
              {git.dirty && ` · ${git.files.length} changed`}
              {git.ahead > 0 && ` ↑${git.ahead}`}
              {git.behind > 0 && ` ↓${git.behind}`}
            </button>
          )}
        </>
      )}
      <span className="spacer" />
      {working > 0 && <span className="sb-item">● {working} working</span>}
      {blocked > 0 && <button className="sb-item clickable attn" onClick={jumpToAttention} title="Jump (⌘J)">▲ {blocked} waiting for you</button>}
      {done > 0 && <button className="sb-item clickable ok" onClick={jumpToAttention} title="Jump (⌘J)">✓ {done} done</button>}
      {project && (
        <button
          className="sb-item clickable"
          title={override ? "Claude model for this project (Project Settings)" : "Default Claude model for new sessions (Settings → Claude)"}
          onClick={() => setModal(override ? { kind: "projectSettings", projectId: project.id } : { kind: "profiles", section: "claude" })}
        >
          ✳ {modelLabel(model)}
          {override && " · project"}
        </button>
      )}
    </div>
  );
}
