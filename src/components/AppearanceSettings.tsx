import { useMemo, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useWorkspace } from "../store/workspace";
import { BUILTIN_ENTRIES, useTheming } from "../theming/store";
import { BUILTIN_ICON_THEME_ID, BUILTIN_ICON_THEME_LABEL } from "../theming/iconTheme";
import type { ThemeEntry } from "../theming/types";
import { COMMANDS, effectiveBindings, keyLabel } from "../commands";

const isLight = (t: ThemeEntry) => t.uiTheme === "vs" || t.uiTheme === "hc-light";

function ThemeSelect({ value, onChange, themes, filter }: { value: string; onChange(v: string): void; themes: ThemeEntry[]; filter?: (t: ThemeEntry) => boolean }) {
  const list = filter ? themes.filter(filter) : themes;
  const groups = useMemo(() => {
    const m = new Map<string, ThemeEntry[]>();
    for (const t of list) m.set(t.source, [...(m.get(t.source) ?? []), t]);
    return [...m];
  }, [list]);
  const known = list.some((t) => t.id === value || t.label === value);
  return (
    <select value={known ? list.find((t) => t.id === value || t.label === value)!.id : value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
      {!known && <option value={value}>{value} (not found)</option>}
      {groups.map(([source, items]) => (
        <optgroup key={source} label={source}>
          {items.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Settings → Appearance: color/icon themes, config files. Everything is stored in ~/.tcon/settings.json. */
export function AppearanceSettings() {
  const settings = useTheming((s) => s.settings);
  const setSetting = useTheming((s) => s.setSetting);
  const catalog = useTheming((s) => s.catalog);
  const dir = useTheming((s) => s.dir);
  const e1 = useTheming((s) => s.settingsError);
  const e2 = useTheming((s) => s.keybindingsError);
  const e3 = useTheming((s) => s.themeError);
  const e4 = useTheming((s) => s.iconThemeError);
  const errors = [e1, e2, e3, e4].filter(Boolean) as string[];
  const rescan = useTheming((s) => s.rescan);
  const [scanning, setScanning] = useState(false);

  const themes = [...BUILTIN_ENTRIES, ...catalog.colorThemes];
  const auto = settings["window.autoDetectColorScheme"] !== false;
  const get = (k: string, d: string) => (typeof settings[k] === "string" ? (settings[k] as string) : d);
  const iconTheme = settings["workbench.iconTheme"] === null ? "" : get("workbench.iconTheme", BUILTIN_ICON_THEME_ID);

  const openInEditor = (name: string) => {
    const st = useWorkspace.getState();
    const id = st.activeProjectId;
    if (!dir || !id) return void (dir && openPath(`${dir}/${name}`).catch(() => {}));
    st.setModal(null);
    st.openEditor(id, `${dir}/${name}`);
  };

  return (
    <div className="field">
      <span className="field-label">Appearance</span>
      <label className="check">
        <input type="checkbox" checked={auto} onChange={(e) => void setSetting("window.autoDetectColorScheme", e.target.checked)} />
        Follow the system appearance (light / dark)
      </label>
      {auto ? (
        <>
          <div className="row">
            <span className="appearance-label">Dark theme</span>
            <ThemeSelect themes={themes} value={get("workbench.preferredDarkColorTheme", "tCon Dark")} filter={(t) => !isLight(t)} onChange={(v) => void setSetting("workbench.preferredDarkColorTheme", v)} />
          </div>
          <div className="row">
            <span className="appearance-label">Light theme</span>
            <ThemeSelect themes={themes} value={get("workbench.preferredLightColorTheme", "tCon Light")} filter={isLight} onChange={(v) => void setSetting("workbench.preferredLightColorTheme", v)} />
          </div>
        </>
      ) : (
        <div className="row">
          <span className="appearance-label">Color theme</span>
          <ThemeSelect themes={themes} value={get("workbench.colorTheme", "tCon Dark")} onChange={(v) => void setSetting("workbench.colorTheme", v)} />
        </div>
      )}
      <div className="row">
        <span className="appearance-label">File icons</span>
        <select value={iconTheme} onChange={(e) => void setSetting("workbench.iconTheme", e.target.value || null)} style={{ flex: 1, minWidth: 0 }}>
          <option value={BUILTIN_ICON_THEME_ID}>{BUILTIN_ICON_THEME_LABEL}</option>
          {catalog.iconThemes.filter((t) => t.id !== BUILTIN_ICON_THEME_ID).map((t) => (
            <option key={t.id} value={t.id}>{t.label} — {t.source}</option>
          ))}
          <option value="">None</option>
        </select>
      </div>
      <label className="check">
        <input type="checkbox" checked={settings["tcon.customCss"] === true} onChange={(e) => void setSetting("tcon.customCss", e.target.checked)} />
        Load custom.css
      </label>
      {errors.map((e) => (
        <div key={e} className="hint" style={{ color: "var(--danger)" }}>{e}</div>
      ))}
      <div className="hint">
        Themes are found in VS Code, Cursor, VSCodium and Windsurf ({catalog.colorThemes.length} color, {catalog.iconThemes.length} icon themes).
        Add your own as <code>.json</code> files in <code>~/.tcon/themes</code> or unpacked extensions in <code>~/.tcon/extensions</code>.
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" onClick={() => openInEditor("settings.json")}>settings.json</button>
        <button className="btn" onClick={() => openInEditor("keybindings.json")}>keybindings.json</button>
        <button className="btn" onClick={() => openInEditor("custom.css")}>custom.css</button>
        <button className="btn" onClick={() => dir && void openPath(dir).catch(() => {})}>Open folder</button>
        <button
          className="btn"
          disabled={scanning}
          onClick={async () => {
            setScanning(true);
            await rescan();
            setScanning(false);
          }}
        >
          {scanning ? "Scanning…" : "Rescan themes"}
        </button>
      </div>
    </div>
  );
}

/** Settings → Keyboard Shortcuts: effective bindings (defaults + keybindings.json). */
export function KeybindingList() {
  const user = useTheming((s) => s.keybindings);
  const bindings = useMemo(() => effectiveBindings(user), [user]);
  const [open, setOpen] = useState(false);
  return (
    <div className="field">
      <span className="field-label" style={{ cursor: "pointer" }} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Keyboard shortcuts
      </span>
      {open && (
        <div className="recent-list keybinding-list">
          {COMMANDS.map((c) => {
            const keys = bindings.filter((b) => b.command === c.id);
            return (
              <div key={c.id} className="recent-item" style={{ cursor: "default" }}>
                <span className="recent-name" style={{ flex: 1 }}>{c.title}</span>
                <code className="hint">{c.id}</code>
                <span style={{ display: "flex", gap: 4 }}>
                  {keys.length === 0 ? <span className="hint">—</span> : keys.slice(0, 3).map((b, i) => (
                    <span key={i} className="kbd" title={b.when ? `when: ${b.when}` : undefined}>{keyLabel(b.key)}</span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
