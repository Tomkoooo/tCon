// "Tasks: Import Notes…": paste meeting notes / memos; a Claude session splits them into Inbox
// tasks, for the active project or distributed over the open projects' boards.
import { useMemo, useState } from "react";
import { api } from "../../api";
import { projectModel } from "../../claudeModel";
import { useWorkspace } from "../../store/workspace";
import { tasksApi } from "../../tasks/api";
import { useTasks } from "../../tasks/store";
import { Modal } from "../Modal";
import { Segmented, Toggle } from "../ui";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function buildImportPrompt(opts: { notesFile: string; targets: { name: string; root: string }[]; plan: boolean }): string {
  const list = opts.targets.map((t) => `"${t.name}" at ${t.root}`).join("; ");
  const single = opts.targets.length === 1;
  return oneLine(`
    Read the notes in ${opts.notesFile} and turn them into tCon tasks.
    ${single ? `All tasks go to the project ${list}.` : `Distribute the tasks over these projects by topic: ${list}. If you can't tell which project an item belongs to, ask me before creating it.`}
    Follow "Creating tasks" in the tCon task protocol (<project>/.tcon/PROTOCOL.md): one task file per actionable item
    in <project>/.tcon/tasks/, with the next free id of that project, status: inbox, agent: idle, a short title, and the
    item's original text copied word for word into the description (keep the notes' language).
    Skip items that are not actionable. Don't change any code.
    ${opts.plan ? `When all tasks exist, triage them: follow the "Triage (plan only)" section for each new task.` : ""}
    Finish with a short summary: which tasks you created in which project, and anything you skipped and why.
    Then delete ${opts.notesFile}.
  `);
}

export function ImportNotesModal({ onClose }: { onClose(): void }) {
  const projects = useWorkspace((s) => s.order.map((id) => s.projects[id]).filter(Boolean));
  const activeId = useWorkspace((s) => s.activeProjectId);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"active" | "spread">("active");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(projects.map((p) => p.id)));
  const [plan, setPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = projects.find((p) => p.id === activeId) ?? projects[0];
  const targets = useMemo(
    () => (target === "active" ? (active ? [active] : []) : projects.filter((p) => picked.has(p.id))),
    [target, active, projects, picked],
  );

  const start = async () => {
    if (!text.trim() || !targets.length || !active) return;
    setBusy(true);
    setError(null);
    try {
      for (const t of targets) await tasksApi.init(t.rootPath);
      const host = target === "active" ? active : targets.find((t) => t.id === active.id) ?? targets[0];
      const notesFile = `${trim(host.rootPath)}/.tcon/import-${Date.now()}.md`;
      await api.fsWriteText(notesFile, text);
      const prompt = buildImportPrompt({ notesFile, targets: targets.map((t) => ({ name: t.name, root: trim(t.rootPath) })), plan });
      const model = projectModel(host);
      const flags = [
        model === "default" ? "" : `--model ${shq(model)}`,
        ...targets.filter((t) => t.id !== host.id).map((t) => `--add-dir ${shq(t.rootPath)}`),
      ].filter(Boolean).join(" ");
      const cmd = `cd ${shq(host.rootPath)} && claude ${flags} ${shq(prompt)}`.replace(/\s+/g, " ");
      const paneId = useWorkspace.getState().addTerminal(host.id, { claude: true, command: cmd, title: "Import notes → tasks", ephemeral: true });
      if (!paneId) throw new Error("Couldn't open a terminal.");
      useTasks.getState().setNotice(`Claude is turning your notes into tasks in ${targets.length === 1 ? targets[0].name : `${targets.length} projects`}.`);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Import notes as tasks" subtitle="Claude splits them into Inbox cards" onClose={onClose} className="wide">
      <div className="modal-body">
        <textarea
          className="tk-import-text"
          autoFocus
          rows={14}
          placeholder={"Paste meeting notes, a memo or a to-do list.\nEach actionable item becomes a task; the original text is kept in its description."}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void start()}
        />
        <div className="tk-import-opts">
          <Segmented<"active" | "spread">
            ariaLabel="Target"
            value={target}
            onChange={setTarget}
            options={[
              { value: "active", label: active ? `Only ${active.name}` : "Active project" },
              { value: "spread", label: "Distribute over projects", title: "Claude picks the project for each item and asks when unsure" },
            ]}
          />
          <Toggle checked={plan} onChange={setPlan} label="Plan them afterwards" />
        </div>
        {target === "spread" && (
          <div className="tk-import-projects">
            {projects.map((p) => (
              <label key={p.id} className="tk-import-project">
                <input
                  type="checkbox"
                  checked={picked.has(p.id)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(p.id);
                      else n.delete(p.id);
                      return n;
                    })
                  }
                />
                <span className="tk-import-dot" style={{ background: p.color }} />
                {p.name}
              </label>
            ))}
          </div>
        )}
        {error && <div className="tkb-error">{error}</div>}
      </div>
      <div className="modal-foot">
        <span className="tk-import-hint">The notes are saved in .tcon/ for Claude to read, then deleted.</span>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !text.trim() || !targets.length} onClick={() => void start()}>
          Create tasks with Claude <span className="tk-kbd">⌘↵</span>
        </button>
      </div>
    </Modal>
  );
}
