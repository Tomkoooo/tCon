// Settings sections backed by ~/.tcon/settings.json / keybindings.json (VS Code formats):
// Appearance, Terminal and Keyboard Shortcuts.
import { useContext, useMemo } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useWorkspace } from "../store/workspace";
import { BUILTIN_ENTRIES, useTheming } from "../theming/store";
import { BUILTIN_ICON_THEME_ID, BUILTIN_ICON_THEME_LABEL } from "../theming/iconTheme";
import type { ThemeEntry } from "../theming/types";
import { COMMANDS, effectiveBindings, keyLabel } from "../commands";
import { CommitInput, Segmented, Select, Toggle } from "./ui";
import { SettingRow, SettingsGroup, SettingsSearch, SettingsSection, matches, useSetting } from "./settingsKit";

const isLight = (t: ThemeEntry) => t.uiTheme === "vs" || t.uiTheme === "hc-light";

/** Open a file from ~/.tcon in tCon's editor (or the OS when no project is open). */
export function openConfigInEditor(name: string) {
  const dir = useTheming.getState().dir;
  const st = useWorkspace.getState();
  const id = st.activeProjectId;
  if (!dir) return;
  if (!id) return void openPath(`${dir}/${name}`).catch(() => {});
  st.setModal(null);
  st.openEditor(id, `${dir}/${name}`);
}

function ThemeSelect({ value, onChange, themes, filter }: { value: string; onChange(v: string): void; themes: ThemeEntry[]; filter?: (t: ThemeEntry) => boolean }) {
  const list = filter ? themes.filter(filter) : themes;
  const groups = useMemo(() => {
    const m = new Map<string, ThemeEntry[]>();
    for (const t of list) m.set(t.source, [...(m.get(t.source) ?? []), t]);
    return [...m];
  }, [list]);
  const found = list.find((t) => t.id === value || t.label === value);
  return (
    <Select value={found ? found.id : value} onChange={onChange} className="wide">
      {!found && <option value={value}>{value} (not found)</option>}
      {groups.map(([source, items]) => (
        <optgroup key={source} label={source}>
          {items.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

function NumberSetting({ k, fallback, min, max, step = 1, unit }: { k: string; fallback: number; min?: number; max?: number; step?: number; unit?: string }) {
  const [v, set] = useSetting<number>(k, fallback);
  return (
    <span className="row" style={{ gap: 6 }}>
      <CommitInput
        type="number"
        width={80}
        min={min}
        max={max}
        step={step}
        value={String(v)}
        onCommit={(s) => {
          const n = Number(s);
          if (s.trim() && isFinite(n)) set(min !== undefined || max !== undefined ? Math.min(max ?? n, Math.max(min ?? n, n)) : n);
        }}
      />
      {unit && <span className="hint">{unit}</span>}
    </span>
  );
}

function TextSetting({ k, placeholder, mono }: { k: string; placeholder?: string; mono?: boolean }) {
  const [v, set] = useSetting<string>(k, "");
  return <CommitInput value={v} placeholder={placeholder} mono={mono} width={260} onCommit={(s) => set(s.trim())} />;
}

export function AppearanceSection() {
  const settings = useTheming((s) => s.settings);
  const setSetting = useTheming((s) => s.setSetting);
  const catalog = useTheming((s) => s.catalog);
  const errs = [useTheming((s) => s.themeError), useTheming((s) => s.iconThemeError)].filter(Boolean) as string[];

  const themes = [...BUILTIN_ENTRIES, ...catalog.colorThemes];
  const auto = settings["window.autoDetectColorScheme"] !== false;
  const get = (k: string, d: string) => (typeof settings[k] === "string" ? (settings[k] as string) : d);
  const iconTheme = settings["workbench.iconTheme"] === null ? "" : get("workbench.iconTheme", BUILTIN_ICON_THEME_ID);

  return (
    <SettingsSection
      id="appearance"
      title="Appearance"
      description={
        <>
          Uses your VS Code, Cursor, VSCodium and Windsurf themes ({catalog.colorThemes.length} color, {catalog.iconThemes.length} icon themes found).
          Drop extra themes in <code>~/.tcon/themes</code> or unpacked extensions in <code>~/.tcon/extensions</code>.
        </>
      }
    >
      {errs.map((e) => (
        <div key={e} className="settings-error">{e}</div>
      ))}
      <SettingsGroup title="Theme" />
      <SettingRow label="Follow system appearance" description="Switch between a light and a dark theme with macOS." settingKey="window.autoDetectColorScheme" keywords="dark light mode">
        <Toggle checked={auto} onChange={(v) => void setSetting("window.autoDetectColorScheme", v)} />
      </SettingRow>
      {auto ? (
        <>
          <SettingRow label="Dark theme" settingKey="workbench.preferredDarkColorTheme" keywords="color theme">
            <ThemeSelect themes={themes} value={get("workbench.preferredDarkColorTheme", "tCon Dark")} filter={(t) => !isLight(t)} onChange={(v) => void setSetting("workbench.preferredDarkColorTheme", v)} />
          </SettingRow>
          <SettingRow label="Light theme" settingKey="workbench.preferredLightColorTheme" keywords="color theme">
            <ThemeSelect themes={themes} value={get("workbench.preferredLightColorTheme", "tCon Light")} filter={isLight} onChange={(v) => void setSetting("workbench.preferredLightColorTheme", v)} />
          </SettingRow>
        </>
      ) : (
        <SettingRow label="Color theme" settingKey="workbench.colorTheme" keywords="dark light">
          <ThemeSelect themes={themes} value={get("workbench.colorTheme", "tCon Dark")} onChange={(v) => void setSetting("workbench.colorTheme", v)} />
        </SettingRow>
      )}
      <SettingRow label="File icon theme" settingKey="workbench.iconTheme" keywords="icons explorer">
        <Select value={iconTheme} onChange={(v) => void setSetting("workbench.iconTheme", v || null)} className="wide">
          <option value={BUILTIN_ICON_THEME_ID}>{BUILTIN_ICON_THEME_LABEL}</option>
          {catalog.iconThemes.filter((t) => t.id !== BUILTIN_ICON_THEME_ID).map((t) => (
            <option key={t.id} value={t.id}>{t.label} — {t.source}</option>
          ))}
          <option value="">None</option>
        </Select>
      </SettingRow>

      <SettingsGroup title="Fonts" />
      <SettingRow label="UI font size" settingKey="workbench.fontSize" keywords="zoom text size">
        <NumberSetting k="workbench.fontSize" fallback={13} min={10} max={20} unit="px" />
      </SettingRow>
      <SettingRow label="Editor font family" description="CSS font-family list. Empty uses the system monospace font." settingKey="editor.fontFamily" keywords="font mono code">
        <TextSetting k="editor.fontFamily" placeholder="SF Mono, Menlo, monospace" mono />
      </SettingRow>
      <SettingRow label="Editor font size" settingKey="editor.fontSize" keywords="code text">
        <NumberSetting k="editor.fontSize" fallback={13} min={8} max={32} unit="px" />
      </SettingRow>
      <SettingRow label="Editor line height" description="Multiplier (e.g. 1.5) or pixels." settingKey="editor.lineHeight">
        <NumberSetting k="editor.lineHeight" fallback={1.5} min={0} max={60} step={0.1} />
      </SettingRow>

      <SettingsGroup title="Customization" />
      <SettingRow label="Load custom.css" description="Apply ~/.tcon/custom.css on top of the theme (reloads on save)." settingKey="tcon.customCss" keywords="css style">
        <span className="row" style={{ gap: 8 }}>
          <button className="btn small ghost" onClick={() => openConfigInEditor("custom.css")}>Edit</button>
          <Toggle checked={settings["tcon.customCss"] === true} onChange={(v) => void setSetting("tcon.customCss", v)} />
        </span>
      </SettingRow>
    </SettingsSection>
  );
}

export function TerminalSection() {
  const [cursorStyle, setCursorStyle] = useSetting<string>("terminal.integrated.cursorStyle", "block");
  const [blink, setBlink] = useSetting<boolean>("terminal.integrated.cursorBlink", true);
  return (
    <SettingsSection id="terminal" title="Terminal" description="Applies to every terminal immediately, including running sessions.">
      <SettingRow label="Font family" settingKey="terminal.integrated.fontFamily" keywords="font mono">
        <TextSetting k="terminal.integrated.fontFamily" placeholder='"SF Mono", Menlo, monospace' mono />
      </SettingRow>
      <SettingRow label="Font size" settingKey="terminal.integrated.fontSize">
        <NumberSetting k="terminal.integrated.fontSize" fallback={13} min={8} max={32} unit="px" />
      </SettingRow>
      <SettingRow label="Line height" settingKey="terminal.integrated.lineHeight">
        <NumberSetting k="terminal.integrated.lineHeight" fallback={1.15} min={1} max={2} step={0.05} />
      </SettingRow>
      <SettingRow label="Cursor style" settingKey="terminal.integrated.cursorStyle">
        <Segmented
          value={(["block", "underline", "bar"].includes(cursorStyle) ? cursorStyle : "block") as "block" | "underline" | "bar"}
          onChange={setCursorStyle}
          options={[
            { value: "block", label: "Block" },
            { value: "underline", label: "Underline" },
            { value: "bar", label: "Bar" },
          ]}
        />
      </SettingRow>
      <SettingRow label="Blinking cursor" settingKey="terminal.integrated.cursorBlink">
        <Toggle checked={blink} onChange={setBlink} />
      </SettingRow>
      <SettingRow label="Scrollback" description="Lines kept per terminal." settingKey="terminal.integrated.scrollback" keywords="history buffer">
        <NumberSetting k="terminal.integrated.scrollback" fallback={15000} min={1000} max={200000} step={1000} unit="lines" />
      </SettingRow>
    </SettingsSection>
  );
}

/** Settings → Keyboard Shortcuts: effective bindings (defaults + keybindings.json). */
export function KeybindingsSection() {
  const user = useTheming((s) => s.keybindings);
  const q = useContext(SettingsSearch);
  const bindings = useMemo(() => effectiveBindings(user), [user]);
  const rows = COMMANDS.filter((c) => matches(q, c.title, c.id, "keyboard shortcut keybinding"));
  return (
    <SettingsSection
      id="keyboard"
      title="Keyboard Shortcuts"
      description={
        <>
          Defaults plus your overrides from <code>keybindings.json</code> (VS Code format; <code>-command</code> removes a default).{" "}
          <button className="link-btn" onClick={() => openConfigInEditor("keybindings.json")}>Open keybindings.json</button>
        </>
      }
    >
      {rows.length > 0 && (
        <div className="kb-table">
          {rows.map((c) => {
            const keys = bindings.filter((b) => b.command === c.id);
            return (
              <div key={c.id} className="kb-row setting-row">
                <span className="kb-title">{c.title}</span>
                <code className="kb-id">{c.id}</code>
                <span className="kb-keys">
                  {keys.length === 0 ? <span className="hint">—</span> : keys.slice(0, 3).map((b, i) => (
                    <span key={i} className="kbd" title={b.when ? `when: ${b.when}` : undefined}>{keyLabel(b.key)}</span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}
