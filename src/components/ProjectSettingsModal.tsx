import { useState } from "react";
import { PALETTE, useWorkspace } from "../store/workspace";
import { useTheming } from "../theming/store";
import { MODEL_SETTING, modelLabel, normalizeModel } from "../claudeModel";
import { Modal } from "./Modal";
import { ModelPicker } from "./ProfilesModal";
import { ColorPicker, Field, Segmented } from "./ui";
import { normalizeUrl } from "../browser/api";
import { Icon } from "./icons";

export function envToText(env: Record<string, string> | null | undefined) {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}
export function textToEnv(text: string) {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}
// Mirrors security::is_secret_env_name in the backend, which drops these names too.
const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

export function ProjectSettingsModal({ projectId }: { projectId: string }) {
  const project = useWorkspace((s) => s.projects[projectId]);
  const profiles = useWorkspace((s) => s.profiles);
  const update = useWorkspace((s) => s.updateProject);
  const setModal = useWorkspace((s) => s.setModal);
  const globalModel = useTheming((s) => normalizeModel(s.settings[MODEL_SETTING]));
  const [name, setName] = useState(project?.name ?? "");
  const [label, setLabel] = useState(project?.accountLabel ?? "");
  const [color, setColor] = useState(project?.color ?? PALETTE[0]);
  const [modelMode, setModelMode] = useState<"inherit" | "override">(project?.claudeModel ? "override" : "inherit");
  const [model, setModel] = useState(project?.claudeModel ? normalizeModel(project.claudeModel) : globalModel);
  const [envText, setEnvText] = useState(envToText(project?.env));
  const [devUrl, setDevUrl] = useState(project?.browserUrl ?? "");
  const [profileId, setProfileId] = useState(project?.profileId ?? null);
  const [error, setError] = useState("");
  if (!project) return null;
  const profile = profiles.find((p) => p.id === profileId);

  const save = () => {
    const env = textToEnv(envText);
    if (Object.keys(env).some((k) => SECRET_RE.test(k))) {
      return setError("API keys and tokens would be stored unencrypted here. Sign in under Settings → Accounts instead.");
    }
    const browserUrl = devUrl.trim() ? normalizeUrl(devUrl) : null;
    if (devUrl.trim() && !browserUrl) return setError(`“${devUrl.trim()}” isn't a web address.`);
    update(projectId, {
      name: name.trim() || project.name,
      accountLabel: label.trim() || null,
      color,
      profileId,
      claudeModel: modelMode === "override" ? model : null,
      env: Object.keys(env).length ? env : null,
      browserUrl,
    });
    setModal(null);
  };

  return (
    <Modal title="Project Settings" subtitle={project.rootPath.replace(/^\/Users\/[^/]+/, "~")} onClose={() => setModal(null)}>
      <div className="modal-body" onKeyDown={(e) => e.key === "Enter" && e.metaKey && save()}>
        <div className="row top">
          <Field label="Name" grow>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tab badge" hint="Short label shown on the tab." grow>
            <input placeholder="e.g. client" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </div>
        <Field label="Color">
          <ColorPicker value={color} onChange={setColor} palette={PALETTE} />
        </Field>

        <Field
          label="Claude model"
          hint={modelMode === "inherit" ? "Change the global default in Settings → Claude." : "Applies to new Claude sessions in this project."}
        >
          <div className="stack">
            <Segmented
              value={modelMode}
              onChange={(v) => setModelMode(v)}
              options={[
                { value: "inherit", label: `Global default: ${modelLabel(globalModel)}` },
                { value: "override", label: "Override for this project" },
              ]}
            />
            {modelMode === "override" && <ModelPicker value={model} onChange={setModel} />}
          </div>
        </Field>

        <Field label="Dev server URL" hint="Opened by Browser: Open Dev Server. Empty = the latest local URL a terminal printed.">
          <input placeholder="http://localhost:5173" spellCheck={false} value={devUrl} onChange={(e) => setDevUrl(e.target.value)} />
        </Field>

        <details className="advanced" open={!!project.env || !!profile}>
          <summary><Icon name="chevronRight" size={14} />Environment variables</summary>
          <Field label="Environment" hint="KEY=value per line. Added to every new terminal in this project.">
            <textarea
              rows={4}
              className="mono"
              spellCheck={false}
              placeholder={"NODE_ENV=development\n# lines starting with # are ignored"}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
          </Field>
          {profile && (
            <div className="legacy-note">
              <div>
                This project still uses the legacy launch profile <b>{profile.name}</b> ({Object.keys(profile.env).join(", ") || "no variables"}). Profiles are replaced
                by Accounts.
              </div>
              <div className="row">
                <button
                  className="btn small"
                  onClick={() => {
                    const merged = { ...profile.env, ...textToEnv(envText) };
                    setEnvText(envToText(merged));
                    setProfileId(null);
                  }}
                >
                  Move variables into this project
                </button>
                <button className="btn small ghost" onClick={() => setProfileId(null)}>Detach profile</button>
              </div>
            </div>
          )}
        </details>
        {error && <div className="settings-error">{error}</div>}
      </div>
      <div className="modal-foot">
        <span className="hint">Applies to new terminals · ⌘↵ to save</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
