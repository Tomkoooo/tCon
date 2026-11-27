import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { PALETTE, useWorkspace } from "../store/workspace";
import type { RecentPath } from "../types";
import { Modal } from "./Modal";

function relTime(ms: number) {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

export function NewProjectModal() {
  const setModal = useWorkspace((s) => s.setModal);
  const openProject = useWorkspace((s) => s.openProject);
  const profiles = useWorkspace((s) => s.profiles);
  const projects = useWorkspace((s) => s.projects);

  const [recent, setRecent] = useState<RecentPath[]>([]);
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | undefined>();
  const [claude, setClaude] = useState(true);
  const [profileId, setProfileId] = useState<string>("");
  const [newFolder, setNewFolder] = useState<{ parent: string; name: string; git: boolean } | null>(null);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(0);

  const reload = () => api.recentList(30).then(setRecent).catch(() => setRecent([]));
  useEffect(() => {
    void reload();
    api.settingGet("lastProfileId").then((v) => v && setProfileId(v)).catch(() => {});
  }, []);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return recent.filter((r) => !f || r.path.toLowerCase().includes(f));
  }, [recent, filter]);

  const close = () => setModal(null);
  const openPath = Object.values(projects).find((p) => p.rootPath === path);

  const submit = async () => {
    setError("");
    let target = path;
    try {
      if (newFolder) {
        if (!newFolder.parent || !newFolder.name.trim()) return setError("Pick a parent folder and a name.");
        target = `${newFolder.parent.replace(/\/+$/, "")}/${newFolder.name.trim()}`;
        await api.fsCreateProjectDir(target, newFolder.git);
      }
      if (!target) return setError("Pick a folder.");
      await api.settingSet("lastProfileId", profileId).catch(() => {});
      openProject({ path: target, name: name.trim() || undefined, color, profileId: profileId || null, claude });
      close();
    } catch (e) {
      setError(String(e));
    }
  };

  const browse = async () => {
    const dir = await open({ directory: true, multiple: false, defaultPath: path || undefined });
    if (typeof dir === "string") {
      if (newFolder) setNewFolder({ ...newFolder, parent: dir });
      else setPath(dir);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const c = Math.min(shown.length - 1, cursor + 1);
      setCursor(c);
      if (shown[c]) setPath(shown[c].path);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const c = Math.max(0, cursor - 1);
      setCursor(c);
      if (shown[c]) setPath(shown[c].path);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!path && shown[0]) setPath(shown[0].path);
      void submit();
    }
  };

  return (
    <Modal title="Open project" onClose={close}>
      <div className="modal-body" onKeyDown={onKey}>
        {!newFolder ? (
          <>
            <div className="row">
              <input
                autoFocus
                placeholder="Filter recent projects…"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setCursor(0);
                }}
              />
              <button className="btn" onClick={browse}>Browse…</button>
              <button className="btn" onClick={() => setNewFolder({ parent: path || "", name: "", git: true })}>New folder…</button>
            </div>
            <div className="recent-list">
              {shown.length === 0 && <div className="recent-item hint">No recent projects yet — use Browse…</div>}
              {shown.map((r, i) => (
                <div
                  key={r.path}
                  className={`recent-item${r.path === path ? " selected" : ""}`}
                  onClick={() => {
                    setPath(r.path);
                    setCursor(i);
                  }}
                  onDoubleClick={() => {
                    setPath(r.path);
                    openProject({ path: r.path, color, profileId: profileId || null, claude });
                    close();
                  }}
                >
                  <button
                    className={`star${r.pinned ? " on" : ""}`}
                    title={r.pinned ? "Unpin" : "Pin to top"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.recentPin(r.path, !r.pinned).then(reload);
                    }}
                  >
                    {r.pinned ? "★" : "☆"}
                  </button>
                  <span className="recent-name">{base(r.path)}</span>
                  <span className="recent-path" title={r.path}>{r.path}</span>
                  <span className="recent-time">{relTime(r.lastUsed)}</span>
                  <button
                    className="star"
                    title="Remove from recent"
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.recentRemove(r.path).then(reload);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {path && (
              <div className="hint">
                Selected: <b>{path}</b>
                {openPath && " — already open: a new pane will be added to that tab"}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="field">
              <label>Parent folder</label>
              <div className="row">
                <input value={newFolder.parent} onChange={(e) => setNewFolder({ ...newFolder, parent: e.target.value })} />
                <button className="btn" onClick={browse}>Browse…</button>
              </div>
            </div>
            <div className="field">
              <label>Folder name</label>
              <input autoFocus value={newFolder.name} onChange={(e) => setNewFolder({ ...newFolder, name: e.target.value })} />
            </div>
            <label className="check">
              <input type="checkbox" checked={newFolder.git} onChange={(e) => setNewFolder({ ...newFolder, git: e.target.checked })} />
              Initialize git repository
            </label>
            <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setNewFolder(null)}>← Back to recent</button>
          </>
        )}

        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Tab name</label>
            <input placeholder={path ? base(path) : "defaults to folder name"} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Account / profile</label>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">Default</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <span className="field-label">Color</span>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button key={c} className={`swatch${c === color ? " selected" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
            <input type="color" value={color ?? "#6aa7ff"} onChange={(e) => setColor(e.target.value)} style={{ width: 28, height: 22, padding: 0 }} />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={claude} onChange={(e) => setClaude(e.target.checked)} />
          Start a Claude Code session (runs <code>claude</code> in the new terminal)
        </label>
        {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
      </div>
      <div className="modal-foot">
        <span className="hint">↑↓ to pick · Enter to open</span>
        <span className="spacer" />
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={!path && !newFolder}>
          Open
        </button>
      </div>
    </Modal>
  );
}
