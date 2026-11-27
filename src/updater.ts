// Auto-updates from GitHub releases. The check, download and signature verification run in Rust
// (tauri-plugin-updater, endpoint + public key in tauri.conf.json → plugins.updater); this file
// only schedules checks and drives the UI (components/UpdateNotice.tsx, Settings → Updates).
//
// Checks: ~10 s after launch, then every 6 h while `update.autoCheck` is on (default), plus
// "Check for Updates…" (command palette / Settings). Automatic checks are silent on errors.
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";
import { useTheming } from "./theming/store";
import { useWorkspace } from "./store/workspace";

export const AUTO_CHECK_SETTING = "update.autoCheck";
export const CHANNEL_SETTING = "update.channel";
export const RELEASES_URL = "https://github.com/Tomkoooo/tCon/releases";
export const releaseNotesUrl = (version: string) => `${RELEASES_URL}/tag/v${version.replace(/^v/, "")}`;

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "installing" | "upToDate" | "error";

interface UpdaterState {
  /** Running app version (from tauri.conf.json). */
  current: string | null;
  phase: UpdatePhase;
  /** The newer release, once found. */
  available: { version: string; notes: string | null; date: string | null } | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  lastChecked: number | null;
  /** Show the floating notice (hidden by "Later"; the Settings section always shows the state). */
  noticeOpen: boolean;
  /** The last check was started by the user: report "up to date" / errors in the notice too. */
  manual: boolean;
  loadVersion(): Promise<void>;
  checkNow(manual?: boolean): Promise<void>;
  install(): Promise<void>;
  dismiss(): void;
}

let pending: Update | null = null;

export const useUpdater = create<UpdaterState>((set, get) => ({
  current: null,
  phase: "idle",
  available: null,
  downloaded: 0,
  total: null,
  error: null,
  lastChecked: null,
  noticeOpen: false,
  manual: false,

  async loadVersion() {
    if (get().current) return;
    const v = await getVersion().catch(() => null);
    set({ current: v });
  },

  async checkNow(manual = false) {
    const { phase } = get();
    if (phase === "checking" || phase === "downloading" || phase === "installing") {
      if (manual) set({ noticeOpen: true, manual: true });
      return;
    }
    set({ phase: "checking", error: null, manual, noticeOpen: manual || get().noticeOpen });
    try {
      const update = await check();
      set({ lastChecked: Date.now() });
      if (update) {
        const isNew = get().available?.version !== update.version;
        void pending?.close().catch(() => {});
        pending = update;
        set({
          phase: "available",
          available: { version: update.version, notes: update.body ?? null, date: update.date ?? null },
          // a new version re-opens the notice even after "Later"; the same one stays dismissed
          noticeOpen: manual || isNew || get().noticeOpen,
        });
      } else {
        set({ phase: "upToDate", available: null });
        if (manual) window.setTimeout(() => get().phase === "upToDate" && get().manual && set({ noticeOpen: false }), 4000);
      }
    } catch (e) {
      set({ phase: "error", error: String(e), lastChecked: Date.now(), noticeOpen: manual && get().noticeOpen });
    }
  },

  async install() {
    if (!pending || get().phase !== "available") return;
    const busy = Object.values(useWorkspace.getState().statuses).filter((s) => s.state === "working" || s.state === "blocked").length;
    if (busy > 0) {
      const ok = await ask(
        `${busy} Claude session${busy > 1 ? "s are" : " is"} still running. Restarting tCon closes all terminals.\n\nInstall the update and restart now?`,
        { title: "Install update", kind: "warning", okLabel: "Install & restart" },
      ).catch(() => false);
      if (!ok) return;
    }
    set({ phase: "downloading", downloaded: 0, total: null, error: null, noticeOpen: true });
    try {
      await pending.downloadAndInstall((ev) => {
        if (ev.event === "Started") set({ total: ev.data.contentLength ?? null, downloaded: 0 });
        else if (ev.event === "Progress") set({ downloaded: get().downloaded + ev.data.chunkLength });
        else if (ev.event === "Finished") set({ phase: "installing" });
      });
      set({ phase: "installing" });
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: String(e), noticeOpen: true, manual: true });
    }
  },

  dismiss() {
    set({ noticeOpen: false });
  },
}));

/** Start the startup + periodic checks. Returns a cleanup function. */
export function startUpdateChecks(): () => void {
  void useUpdater.getState().loadVersion();
  // app menu → "Check for Updates…" (src-tauri/src/lib.rs). The check itself ignores duplicates.
  const offMenu = listen<string>("menu-command", ({ payload }) => payload === "tcon.checkForUpdates" && checkForUpdates());
  const stopMenu = () => void offMenu.then((f) => f());
  // dev builds have no signed release to compare against
  if (import.meta.env.DEV) return stopMenu;
  const auto = () => {
    if (useTheming.getState().settings[AUTO_CHECK_SETTING] === false) return;
    void useUpdater.getState().checkNow(false);
  };
  const first = window.setTimeout(auto, FIRST_CHECK_MS);
  const every = window.setInterval(auto, CHECK_EVERY_MS);
  return () => {
    stopMenu();
    window.clearTimeout(first);
    window.clearInterval(every);
  };
}

export const checkForUpdates = () => void useUpdater.getState().checkNow(true);
