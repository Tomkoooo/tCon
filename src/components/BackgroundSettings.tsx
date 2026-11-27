// Settings → Quick panel & background: the global shortcut, launch at login, keep running
// after the window closes, and the menu-bar icon (src-tauri/src/background.rs).
import { useEffect, useState } from "react";
import {
  DEFAULT_SHORTCUT, KEEP_RUNNING_KEY, LAUNCH_AT_LOGIN_KEY, SHORTCUT_KEY, SHOW_TRAY_KEY,
  backgroundApi, formatShortcut, useBackground,
} from "../background/bridge";
import { SettingRow, SettingsSection, useSetting } from "./settingsKit";
import { Toggle } from "./ui";

const isMac = navigator.platform.toLowerCase().includes("mac");
const isLinux = navigator.platform.toLowerCase().includes("linux");

/** A keydown → "Alt+Shift+Space"-style string, or null for a lone modifier. */
function shortcutFromEvent(e: React.KeyboardEvent): string | null {
  const code = e.nativeEvent.code;
  if (/^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/.test(code) || !code) return null;
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Cmd"].filter(Boolean);
  return [...mods, key].join("+");
}

function ShortcutRecorder({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onKeyDown = async (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return setRecording(false);
    const s = shortcutFromEvent(e);
    if (!s) return;
    try {
      onChange(await backgroundApi.checkShortcut(s));
      setError(null);
      setRecording(false);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="row wrap">
      <button
        className={`btn small${recording ? " primary" : ""}`}
        style={{ minWidth: 130, fontFamily: "var(--font-mono)" }}
        onClick={() => {
          setError(null);
          setRecording((r) => !r);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
        title="Click, then press the new shortcut"
      >
        {recording ? "Press keys…" : formatShortcut(value)}
      </button>
      {value !== DEFAULT_SHORTCUT && (
        <button className="btn small ghost" onClick={() => onChange(DEFAULT_SHORTCUT)}>
          Reset to {formatShortcut(DEFAULT_SHORTCUT)}
        </button>
      )}
      {error && <span className="hint" style={{ color: "var(--danger)" }}>{error}</span>}
    </div>
  );
}

export function BackgroundSection() {
  const [shortcut, setShortcut] = useSetting<string>(SHORTCUT_KEY, DEFAULT_SHORTCUT);
  const [launch, setLaunch] = useSetting<boolean>(LAUNCH_AT_LOGIN_KEY, false);
  const [keep, setKeep] = useSetting<boolean>(KEEP_RUNNING_KEY, true);
  const [tray, setTray] = useSetting<boolean>(SHOW_TRAY_KEY, true);
  const status = useBackground((s) => s.status);

  useEffect(() => {
    backgroundApi.status().then((s) => useBackground.setState({ status: s })).catch(() => {});
  }, []);

  const shortcutDesc = status?.shortcutError ? (
    <span style={{ color: "var(--danger)" }}>{status.shortcutError}</span>
  ) : (
    <>
      Opens the quick panel from any app: add a task to a project and glance at its board.
      {isLinux && " Works on X11; on Wayland, bind a desktop shortcut instead."}
    </>
  );

  return (
    <SettingsSection
      id="background"
      title="Quick panel & background"
      description="tCon can keep running after you close its window, so the quick panel is one shortcut away."
    >
      <SettingRow label="Quick panel shortcut" settingKey={SHORTCUT_KEY} keywords="global hotkey shortcut quick add todo spotlight panel" description={shortcutDesc}>
        <ShortcutRecorder value={shortcut} onChange={setShortcut} />
      </SettingRow>
      <SettingRow
        label="Launch at login"
        settingKey={LAUNCH_AT_LOGIN_KEY}
        keywords="startup autostart login item boot"
        description="Start tCon in the background when you log in (only the menu-bar icon shows)."
      >
        <Toggle checked={launch} onChange={setLaunch} />
      </SettingRow>
      <SettingRow
        label="Keep running in background"
        settingKey={KEEP_RUNNING_KEY}
        keywords="close window quit hide background tray"
        description={`Closing the window hides it; terminals keep running. ${isMac ? "⌘Q" : "Quit in the tray menu"} quits.`}
      >
        <Toggle checked={keep} onChange={setKeep} />
      </SettingRow>
      <SettingRow label={isMac ? "Show menu-bar icon" : "Show tray icon"} settingKey={SHOW_TRAY_KEY} keywords="tray menu bar icon status">
        <Toggle checked={tray} onChange={setTray} />
      </SettingRow>
    </SettingsSection>
  );
}
