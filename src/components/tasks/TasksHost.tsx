// App-level task runtime: watches .tcon/ for every open project, runs the agent queue /
// auto-pickup logic, and shows the non-blocking "Start Claude on this task?" prompts.
import { useEffect } from "react";
import { useWorkspace } from "../../store/workspace";
import { installTaskWatchers, useTasks } from "../../tasks/store";
import { installAgentRuntime, startAgent } from "../../tasks/agent";
import { hasBackend } from "../../tasks/api";
import { ClaudeMark } from "./parts";
import "./tasks.css";

export function TasksHost() {
  const loaded = useWorkspace((s) => s.loaded);
  const roots = useWorkspace((s) => s.order.map((id) => s.projects[id]?.rootPath).filter(Boolean).join("\n"));
  const prompts = useTasks((s) => s.prompts);

  useEffect(() => {
    const a = installTaskWatchers();
    const b = installAgentRuntime();
    return () => {
      a();
      b();
    };
  }, []);

  // Load every open project's board (after restore, so dead agent panes are reaped correctly).
  useEffect(() => {
    if (!loaded || !hasBackend()) return;
    for (const r of roots.split("\n").filter(Boolean)) useTasks.getState().ensure(r);
  }, [loaded, roots]);

  if (!prompts.length) return null;
  const projects = useWorkspace.getState().projects;
  const multi = new Set(prompts.map((p) => p.root)).size > 1 || Object.keys(projects).length > 1;

  return (
    <div className="tk-toasts" role="status">
      {prompts.map((p) => {
        const project = Object.values(projects).find((x) => x.rootPath.replace(/\/+$/, "") === p.root);
        return (
          <div key={p.key} className="tk-toast">
            <ClaudeMark size={14} />
            <div className="tk-toast-body">
              <div className="tk-toast-title">Start Claude on {p.taskId}?</div>
              <div className="tk-toast-sub" title={p.title}>
                {p.title}
                {multi && project ? <span className="tk-toast-proj"> · {project.name}</span> : null}
              </div>
            </div>
            <div className="tk-toast-actions">
              <button
                className="btn small primary"
                onClick={() => {
                  useTasks.getState().dismissPrompt(p.key);
                  void startAgent(p.root, p.taskId);
                }}
              >
                Start
              </button>
              <button className="btn small ghost" onClick={() => useTasks.getState().dismissPrompt(p.key)}>Not now</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
