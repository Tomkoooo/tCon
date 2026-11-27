import { jumpToAttention } from "../commands";
import { useWorkspace } from "../store/workspace";
import { useTheming } from "../theming/store";
import { MODEL_SETTING, modelLabel, normalizeModel } from "../claudeModel";
import { ClaudeMark, Icon } from "./icons";
import { AgentStatusItem } from "./tasks/AgentStatus";

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
            <button className="sb-item clickable" title="Source Control (⇧⌘G)" onClick={() => updateProject(project.id, { sidebarOpen: true, sidebarTab: "git" })}>
              <Icon name="branch" size={12} />
              {git.branch ?? git.head ?? "detached"}
              {git.dirty && <span className="sb-sep">· {git.files.length} changed</span>}
              {git.ahead > 0 && <span className="sb-sync" title={`${git.ahead} to push`}><Icon name="arrowUp" size={12} />{git.ahead}</span>}
              {git.behind > 0 && <span className="sb-sync" title={`${git.behind} to pull`}><Icon name="arrowDown" size={12} />{git.behind}</span>}
            </button>
          )}
        </>
      )}
      <span className="spacer" />
      <AgentStatusItem />
      {working > 0 && <span className="sb-item"><span className="sb-pip working" />{working} working</span>}
      {blocked > 0 && <button className="sb-item clickable attn" onClick={jumpToAttention} title="Jump to it (⌘J)"><span className="sb-pip" />{blocked} need{blocked === 1 ? "s" : ""} you</button>}
      {done > 0 && <button className="sb-item clickable ok" onClick={jumpToAttention} title="Jump to it (⌘J)"><Icon name="check" size={12} />{done} done</button>}
      {project && (
        <button
          className="sb-item clickable"
          title={override ? "Claude model for this project" : "Default Claude model for new sessions"}
          onClick={() => setModal(override ? { kind: "projectSettings", projectId: project.id } : { kind: "profiles", section: "claude" })}
        >
          <ClaudeMark size={11} />
          {modelLabel(model)}
          {override && <span className="sb-sep">· project</span>}
        </button>
      )}
    </div>
  );
}
