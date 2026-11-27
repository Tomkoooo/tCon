// Settings → Appearance → App icon: built-in variants + a custom image file.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTheming } from "../theming/store";
import { APP_ICON_KEY, APP_ICON_VARIANTS, appIconPreview, appIconSpec, applyAppIcon, isBuiltinAppIcon } from "../theming/appIcon";
import "./AppIconPicker.css";

const isMac = navigator.userAgent.includes("Mac");

export function AppIconPicker() {
  const raw = useTheming((s) => s.settings[APP_ICON_KEY]);
  const setSetting = useTheming((s) => s.setSetting);
  const spec = appIconSpec(raw);
  const custom = isBuiltinAppIcon(spec) ? null : spec;
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    if (custom) void appIconPreview(custom).then(setPreview);
  }, [custom]);

  const choose = async (next: string) => {
    // Apply first so a bad file is reported and never saved.
    const err = await applyAppIcon(next);
    setError(err);
    if (!err) await setSetting(APP_ICON_KEY, next);
  };

  const pick = async () => {
    const file = await open({
      multiple: false,
      directory: false,
      title: "Choose an app icon",
      filters: [{ name: "Images", extensions: isMac ? ["png", "icns", "svg", "jpg", "jpeg", "tiff"] : ["png"] }],
    });
    if (typeof file === "string") await choose(file);
  };

  const name = custom?.split(/[\\/]/).pop();

  return (
    <div className="app-icon-picker">
      <div className="app-icon-grid" role="radiogroup" aria-label="App icon">
        {APP_ICON_VARIANTS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={spec === v.id}
            className={`app-icon-tile${spec === v.id ? " on" : ""}`}
            title={v.label}
            onClick={() => void choose(v.id)}
          >
            <img src={v.src} alt={v.label} draggable={false} />
          </button>
        ))}
        {custom && (
          <button type="button" role="radio" aria-checked className="app-icon-tile on" title={custom}>
            {preview ? <img src={preview} alt={name} draggable={false} /> : <span className="app-icon-ext">{custom.split(".").pop()?.toUpperCase()}</span>}
          </button>
        )}
      </div>
      <div className="app-icon-actions">
        <button type="button" className="btn small ghost" onClick={() => void pick()}>Choose image…</button>
        {custom && (
          <button type="button" className="btn small ghost" onClick={() => void choose("default")} title={custom}>Reset</button>
        )}
      </div>
      {error && <div className="settings-error">{error}</div>}
    </div>
  );
}
