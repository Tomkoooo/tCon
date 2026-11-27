import { useState } from "react";
import { api } from "../api";
import { PALETTE, useWorkspace } from "../store/workspace";
import type { Profile } from "../types";
import { Modal } from "./Modal";

function envToText(env: Record<string, string>) {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}
function textToEnv(text: string) {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD)/i;

export function ProfilesModal() {
  const setModal = useWorkspace((s) => s.setModal);
  const profiles = useWorkspace((s) => s.profiles);
  const loadProfiles = useWorkspace((s) => s.loadProfiles);
  const theme = useWorkspace((s) => s.theme);
  const setTheme = useWorkspace((s) => s.setTheme);
  const [editing, setEditing] = useState<(Profile & { envText: string }) | null>(null);
  const [error, setError] = useState("");

  const startNew = () =>
    setEditing({ id: crypto.randomUUID(), name: "", color: PALETTE[profiles.length % PALETTE.length], env: {}, envText: "CLAUDE_CONFIG_DIR=~/.claude-work" });

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) return setError("Name is required.");
    const env = textToEnv(editing.envText);
    const home = await api.homeDir();
    for (const k of Object.keys(env)) env[k] = env[k].replace(/^~(?=\/|$)/, home);
    if (Object.keys(env).some((k) => SECRET_RE.test(k))) {
      return setError("Don't store API keys/tokens here (stored unencrypted). Use CLAUDE_CONFIG_DIR per account and log in once in each.");
    }
    await api.profileSave({ id: editing.id, name: editing.name.trim(), color: editing.color, env });
    await loadProfiles();
    setEditing(null);
    setError("");
  };

  return (
    <Modal title="Settings" onClose={() => setModal(null)}>
      <div className="modal-body">
        <div className="field">
          <span className="field-label">Theme</span>
          <div className="row">
            {(["system", "dark", "light"] as const).map((t) => (
              <label key={t} className="check">
                <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} /> {t}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">Accounts / launch profiles</span>
          <div className="hint">
            A profile labels a project tab and injects environment variables into its terminals. To run separate Claude accounts,
            give each profile its own <code>CLAUDE_CONFIG_DIR</code> and run <code>claude</code> → <code>/login</code> once per profile.
          </div>
          {!editing && (
            <div className="recent-list">
              {profiles.length === 0 && <div className="recent-item hint">No profiles yet.</div>}
              {profiles.map((p) => (
                <div key={p.id} className="recent-item" onClick={() => setEditing({ ...p, envText: envToText(p.env) })}>
                  <span className="swatch" style={{ background: p.color, width: 12, height: 12 }} />
                  <span className="recent-name">{p.name}</span>
                  <span className="recent-path">{Object.keys(p.env).join(", ")}</span>
                  <button
                    className="star"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.profileDelete(p.id).then(loadProfiles);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {editing && (
            <div className="field" style={{ border: "1px solid var(--border)", borderRadius: 7, padding: 10 }}>
              <label>Name (shown as the tab badge, e.g. "work · opus")</label>
              <input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <label>Color</label>
              <div className="swatches">
                {PALETTE.map((c) => (
                  <button key={c} className={`swatch${c === editing.color ? " selected" : ""}`} style={{ background: c }} onClick={() => setEditing({ ...editing, color: c })} />
                ))}
              </div>
              <label>Environment (KEY=value per line)</label>
              <textarea rows={5} style={{ fontFamily: "var(--font-mono)", fontSize: 12 }} value={editing.envText} onChange={(e) => setEditing({ ...editing, envText: e.target.value })} />
              {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => { setEditing(null); setError(""); }}>Cancel</button>
                <button className="btn primary" onClick={save}>Save profile</button>
              </div>
            </div>
          )}
          {!editing && <button className="btn" style={{ alignSelf: "flex-start" }} onClick={startNew}>+ New profile</button>}
        </div>
        <div className="field">
          <span className="field-label">Keyboard shortcuts</span>
          <div className="hint" style={{ lineHeight: 1.9 }}>
            <span className="kbd">⌘T</span> new project · <span className="kbd">⇧⌘C</span> new Claude pane · <span className="kbd">⌘D</span>/<span className="kbd">⇧⌘D</span> split ·{" "}
            <span className="kbd">⌘W</span> close pane · <span className="kbd">⌘1–9</span> switch tab · <span className="kbd">⇧⌘[ ]</span> prev/next tab ·{" "}
            <span className="kbd">⌥⌘←→</span> prev/next pane · <span className="kbd">⌘B</span> sidebar · <span className="kbd">⇧⌘G</span> git ·{" "}
            <span className="kbd">⌘K</span> clear · <span className="kbd">⌘J</span> jump to session needing attention
          </div>
        </div>
      </div>
    </Modal>
  );
}
