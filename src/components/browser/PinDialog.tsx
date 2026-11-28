// Add / edit a pinned web app: name, URL, icon, color and whether it shows in every project.
import { useEffect, useState } from "react";
import { PALETTE } from "../../store/workspace";
import { normalizeUrl } from "../../browser/api";
import { PIN_ICONS, removePin, savePin, usePinDialog, type PinIcon } from "../../browser/pins";
import { Modal } from "../Modal";
import { ColorPicker, Field, Segmented } from "../ui";
import { Icon } from "../icons";
import { PageIcon } from "./BrowserTab";

const ICON_LABELS: Partial<Record<PinIcon, string>> = { favicon: "Site icon", database: "Database", server: "Server", chart: "Dashboard" };

export function PinDialog() {
  const draft = usePinDialog((s) => s.draft);
  const close = usePinDialog((s) => s.close);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [icon, setIcon] = useState<PinIcon>("globe");
  const [color, setColor] = useState(PALETTE[0]);
  const [scope, setScope] = useState<"all" | "project">("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!draft) return;
    setName(draft.pin.name);
    setUrl(draft.pin.url);
    setIcon(draft.pin.icon);
    setColor(draft.pin.color || PALETTE[0]);
    setScope(draft.pin.project ? "project" : "all");
    setError(null);
  }, [draft]);

  if (!draft) return null;
  const { pin, projectRoot, isNew } = draft;
  const projectName = projectRoot.replace(/\/+$/, "").split("/").pop() || projectRoot;
  const icons: PinIcon[] = pin.favicon ? ["favicon", ...PIN_ICONS] : [...PIN_ICONS];

  const save = () => {
    const full = normalizeUrl(url);
    if (!full) return setError(`“${url.trim() || " "}” isn't a web address.`);
    const sameUrl = full === pin.url;
    void savePin({
      ...pin,
      name: name.trim() || new URL(full).host,
      url: full,
      icon,
      color,
      // the remembered favicon belongs to the old address
      favicon: sameUrl ? pin.favicon : null,
      project: scope === "project" ? projectRoot.replace(/\/+$/, "") : null,
    });
    close();
  };

  return (
    <Modal title={isNew ? "Pin to Sidebar" : "Edit Pinned App"} subtitle="Shown in the activity bar, opens in the built-in browser" onClose={close}>
      <div
        className="modal-body"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || (e.target as HTMLElement).tagName === "INPUT")) {
            e.preventDefault();
            save();
          }
        }}
      >
        <div className="row top">
          <Field label="Name" grow>
            <input autoFocus value={name} placeholder="Compass" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="URL" hint="A self-hosted database viewer, dashboard or any web app." grow>
            <input
              value={url}
              placeholder="http://localhost:8081"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
            />
          </Field>
        </div>
        <Field label="Icon">
          <div className="pin-icons" role="radiogroup" aria-label="Icon">
            {icons.map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={icon === i}
                className={`pin-icon-opt${icon === i ? " selected" : ""}`}
                title={ICON_LABELS[i] ?? i[0].toUpperCase() + i.slice(1)}
                style={{ "--pin-color": color } as React.CSSProperties}
                onClick={() => setIcon(i)}
              >
                {i === "favicon" ? <PageIcon src={pin.favicon} size={18} /> : <Icon name={i} size={18} />}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Color">
          <ColorPicker value={color} onChange={setColor} palette={PALETTE} />
        </Field>
        <Field label="Show in">
          <Segmented<"all" | "project">
            value={scope}
            onChange={setScope}
            ariaLabel="Show in"
            options={[
              { value: "all", label: "Every project" },
              { value: "project", label: `Only ${projectName}` },
            ]}
          />
        </Field>
        {error && <div className="settings-error">{error}</div>}
      </div>
      <div className="modal-foot">
        {!isNew && (
          <button
            className="btn ghost danger"
            onClick={() => {
              void removePin(pin.id);
              close();
            }}
          >
            Unpin
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save}>{isNew ? "Pin" : "Save"}</button>
      </div>
    </Modal>
  );
}
