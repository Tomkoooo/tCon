import { useState } from "react";
import { PALETTE, useWorkspace } from "../store/workspace";
import { Modal } from "./Modal";

export function ProjectSettingsModal({ projectId }: { projectId: string }) {
  const project = useWorkspace((s) => s.projects[projectId]);
  const profiles = useWorkspace((s) => s.profiles);
  const update = useWorkspace((s) => s.updateProject);
  const setModal = useWorkspace((s) => s.setModal);
  const [name, setName] = useState(project?.name ?? "");
  const [label, setLabel] = useState(project?.accountLabel ?? "");
  const [profileId, setProfileId] = useState(project?.profileId ?? "");
  const [color, setColor] = useState(project?.color ?? PALETTE[0]);
  if (!project) return null;

  const save = () => {
    update(projectId, { name: name.trim() || project.name, accountLabel: label.trim() || null, profileId: profileId || null, color });
    setModal(null);
  };

  return (
    <Modal title={`Project: ${project.name}`} onClose={() => setModal(null)}>
      <div className="modal-body">
        <div className="hint">{project.rootPath}</div>
        <div className="field">
          <label>Name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>Profile (applies to new panes)</label>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">Default</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Account label (overrides badge)</label>
            <input placeholder="e.g. work · opus" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <span className="field-label">Color</span>
          <div className="swatches">
            {PALETTE.map((c) => <button key={c} className={`swatch${c === color ? " selected" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />)}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 28, height: 22, padding: 0 }} />
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
