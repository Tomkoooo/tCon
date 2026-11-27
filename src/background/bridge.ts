// Main window side of background mode (src-tauri/src/background.rs): pushes the background
// settings from settings.json to Rust, opens what the quick panel / tray ask for, keeps the
// tray's project list fresh and asks once about launching at login.
import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useWorkspace } from "../store/workspace";
import { useTheming } from "../theming/store";
import { openBoard } from "../tasks/actions";

export const SHORTCUT_KEY = "quickPanel.shortcut";
export const LAUNCH_AT_LOGIN_KEY = "app.launchAtLogin";
export const KEEP_RUNNING_KEY = "app.keepRunningInBackground";
export const SHOW_TRAY_KEY = "app.showTrayIcon";
export const DEFAULT_SHORTCUT = "Alt+Shift+Space";
const ASKED_LOGIN_KEY = "background.askedLaunchAtLogin";

export interface BackgroundStatus {
  /** canonical shortcut in effect, null when none is registered */
  shortcut: string | null;
  shortcutError: string | null;
  launchAtLogin: boolean;
  defaultShortcut: string;
}

export const useBackground = create<{ status: BackgroundStatus | null }>(() => ({ status: null }));

export const backgroundApi = {
  apply: (settings: { shortcut?: string; keepRunningInBackground?: boolean; showTrayIcon?: boolean; launchAtLogin?: boolean }) =>
    invoke<BackgroundStatus>("background_apply", { settings }),
  status: () => invoke<BackgroundStatus>("background_status"),
  checkShortcut: (shortcut: string) => invoke<string>("background_check_shortcut", { shortcut }),
  toggleQuick: () => invoke<void>("quick_toggle"),
  trayRefresh: () => invoke<void>("tray_refresh"),
};

/** "Alt+Shift+Space" → "⌥⇧Space" on macOS, unchanged elsewhere. */
export function formatShortcut(s: string): string {
  if (!navigator.platform.toLowerCase().includes("mac")) return s.replace(/\bCmd\b/g, "Super");
  const sym: Record<string, string> = { cmdorctrl: "⌘", cmd: "⌘", command: "⌘", super: "⌘", ctrl: "⌃", control: "⌃", alt: "⌥", option: "⌥", shift: "⇧" };
  const parts = s.split("+");
  const key = parts.pop() ?? "";
  return parts.map((p) => sym[p.toLowerCase()] ?? p).join("") + key;
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

function pick(settings: Record<string, unknown>) {
  const bool = (k: string) => (typeof settings[k] === "boolean" ? (settings[k] as boolean) : undefined);
  const sc = settings[SHORTCUT_KEY];
  return {
    shortcut: typeof sc === "string" ? sc : undefined,
    keepRunningInBackground: bool(KEEP_RUNNING_KEY),
    showTrayIcon: bool(SHOW_TRAY_KEY),
    launchAtLogin: bool(LAUNCH_AT_LOGIN_KEY),
  };
}

async function applyNow() {
  try {
    useBackground.setState({ status: await backgroundApi.apply(pick(useTheming.getState().settings)) });
  } catch {
    /* backend unavailable */
  }
}

/** Open a project (and optionally its board / a task) asked for by the quick panel or tray. */
function openFromQuick(root: string, taskId: string | null, board: boolean) {
  const ws = useWorkspace.getState();
  const r = trim(root);
  const existing = Object.values(ws.projects).find((p) => trim(p.rootPath) === r);
  let id: string;
  if (existing) {
    ws.setActive(existing.id);
    id = existing.id;
  } else {
    id = ws.openProject({ path: r, claude: false });
  }
  if (board || taskId) openBoard(id, taskId ?? null);
}

async function askLaunchAtLoginOnce() {
  try {
    if (await api.settingGet(ASKED_LOGIN_KEY)) return;
    if (!useTheming.getState().settingsText || !document.hasFocus()) return; // ask on a later launch
    await api.settingSet(ASKED_LOGIN_KEY, "1");
    if (useTheming.getState().settings[LAUNCH_AT_LOGIN_KEY] !== undefined) return; // already decided in settings.json
    const sc = formatShortcut(useBackground.getState().status?.shortcut ?? DEFAULT_SHORTCUT);
    const yes = await ask(
      `tCon keeps running in the menu bar after you close its window, so ${sc} opens the quick panel from any app.\n\nStart tCon automatically when you log in? You can change this later in Settings → Quick panel & background.`,
      { title: "Launch tCon at login?", okLabel: "Launch at Login", cancelLabel: "Not Now" },
    );
    await useTheming.getState().setSetting(LAUNCH_AT_LOGIN_KEY, yes);
  } catch {
    /* dialog or backend unavailable */
  }
}

export function useBackgroundBridge() {
  useEffect(() => {
    let applied = "";
    const sync = () => {
      const st = useTheming.getState();
      if (!st.settingsText) return; // settings.json not read yet: don't push defaults over it
      const key = JSON.stringify(pick(st.settings));
      if (key === applied) return;
      applied = key;
      void applyNow();
    };
    sync();
    const offSettings = useTheming.subscribe(sync);

    // Tray "Projects" submenu follows the open projects.
    let trayTimer: number | undefined;
    const offOrder = useWorkspace.subscribe((s, prev) => {
      if (s.order === prev.order && s.activeProjectId === prev.activeProjectId) return;
      window.clearTimeout(trayTimer);
      trayTimer = window.setTimeout(() => void backgroundApi.trayRefresh().catch(() => {}), 1500);
    });

    const offs = [
      listen<{ root: string; taskId: string | null; board: boolean }>("quick-open", ({ payload }) => openFromQuick(payload.root, payload.taskId, payload.board)),
      // Tray "Launch at Login" toggled: record it in settings.json.
      listen<[string, boolean]>("background-setting", ({ payload: [key, value] }) => {
        if (key === LAUNCH_AT_LOGIN_KEY) void useTheming.getState().setSetting(key, value);
      }),
    ];

    const askTimer = window.setTimeout(() => void askLaunchAtLoginOnce(), 4000);
    return () => {
      offSettings();
      offOrder();
      window.clearTimeout(trayTimer);
      window.clearTimeout(askTimer);
      offs.forEach((p) => p.then((f) => f()).catch(() => {}));
    };
  }, []);
}
