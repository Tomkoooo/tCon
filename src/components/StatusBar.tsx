import { jumpToAttention } from "../commands";
import { useWorkspace } from "../store/workspace";

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

  return (
    <div className="statusbar">
      {project && (
        <>
          <span className="sb-item" title={project.rootPath}>{project.rootPath.replace(/^\/Users\/[^/]+/, "~")}</span>
          {git?.isRepo && (
            <span
              className="sb-item"
              style={{ cursor: "pointer" }}
              title="Show git panel (⇧⌘G)"
              onClick={() => updateProject(project.id, { sidebarOpen: true, sidebarTab: "git" })}
            >
              ⎇ {git.branch ?? git.head ?? "detached"}
              {git.dirty && ` · ${git.files.length} changed`}
              {git.ahead > 0 && ` ↑${git.ahead}`}
              {git.behind > 0 && ` ↓${git.behind}`}
            </span>
          )}
        </>
      )}
      <span className="spacer" />
      {working > 0 && <span className="sb-item">● {working} working</span>}
      {blocked > 0 && <span className="sb-item attn" onClick={jumpToAttention} title="Jump (⌘J)">▲ {blocked} waiting for you</span>}
      {done > 0 && <span className="sb-item attn" style={{ color: "var(--ok)" }} onClick={jumpToAttention} title="Jump (⌘J)">✓ {done} done</span>}
    </div>
  );
}
