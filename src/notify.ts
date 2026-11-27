// Desktop notifications for Claude session and task-agent events. Settings (settings.json):
//   notifications.claude      "all" (needs you, done, error) | "attention" (needs you, error) | "off"
//   notifications.whenFocused also notify for a visible session while tCon is in the background
//   notifications.tasks       task agents: blocked, finished, queue empty
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { findPane, isPaneVisible, useWorkspace } from "./store/workspace";
import { useTheming } from "./theming/store";
import type { ProgramStatus } from "./types";

export const NOTIFY_CLAUDE = "notifications.claude";
export const NOTIFY_BACKGROUND = "notifications.whenFocused";
export const NOTIFY_TASKS = "notifications.tasks";
export type ClaudeNotifyMode = "all" | "attention" | "off";

function setting<T>(key: string, fallback: T): T {
  const v = useTheming.getState().settings[key];
  return (typeof v === typeof fallback ? v : fallback) as T;
}

async function appFocused(): Promise<boolean> {
  try {
    return document.hasFocus() && (await getCurrentWindow().isFocused());
  } catch {
    return document.hasFocus();
  }
}

/** Send one desktop notification (asks for permission the first time). */
export async function desktopNotify(title: string, body: string): Promise<void> {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body });
  } catch {
    /* notifications unavailable */
  }
}

/** A Claude pane changed state: notify unless the user is looking at it. */
export async function notifyPaneStatus(paneId: string, status: ProgramStatus): Promise<void> {
  const mode = setting<string>(NOTIFY_CLAUDE, "all") as ClaudeNotifyMode;
  if (mode === "off") return;
  if (mode === "attention" && status.state === "done") return;
  const st = useWorkspace.getState();
  const found = findPane(st, paneId);
  if (!found) return;
  const [project, pane] = found;
  if (isPaneVisible(st, paneId)) {
    // Visible on screen: only worth a notification when tCon itself is in the background.
    if (!setting(NOTIFY_BACKGROUND, true) || (await appFocused())) return;
  }
  const what = status.state === "blocked" ? `needs you${status.kind ? ` (${status.kind})` : ""}` : status.state === "done" ? "is done" : "hit an error";
  await desktopNotify(`${project.name} · ${status.title || pane.title} ${what}`, status.msg || project.rootPath);
}

/** Task-agent events (blocked, finished, queue stopped). */
export async function notifyTask(title: string, body: string): Promise<void> {
  if (!setting(NOTIFY_TASKS, true)) return;
  if (await appFocused()) return;
  await desktopNotify(title, body);
}
