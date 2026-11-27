// Runtime state of the integrated browser: built-in page state (by editor tab id), the managed
// Chrome profile (status + live tabs over CDP) and dev-server URLs detected in terminal output.
// Backend events are subscribed once, when this module is first imported.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { findEditorTab, findPane, useWorkspace } from "../store/workspace";
import { useTheming } from "../theming/store";
import { browserApi, type BrowserEngine, type BrowserInfo, type ChromeStatus, type ChromeTab } from "./api";

export interface PageState {
  url: string;
  title: string;
  loading: boolean;
  favicon: string | null;
  error?: string | null;
  notice?: string | null;
}

export interface DevServer { url: string; paneId: string; at: number }

export const ENGINE_SETTING = "browser.defaultEngine";
export const CHROME_PATH_SETTING = "browser.chromePath";
export const CHROME_PORT_SETTING = "browser.chromeDebugPort";
export const DEFAULT_CHROME_PORT = 9333;

export const defaultEngine = (): BrowserEngine => (useTheming.getState().settings[ENGINE_SETTING] === "chrome" ? "chrome" : "builtin");
export const chromePath = (): string | null => {
  const v = useTheming.getState().settings[CHROME_PATH_SETTING];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
export const chromePort = (): number => {
  const v = Number(useTheming.getState().settings[CHROME_PORT_SETTING]);
  return Number.isInteger(v) && v > 1023 && v < 65536 ? v : DEFAULT_CHROME_PORT;
};

interface BrowserState {
  pages: Record<string, PageState>;
  info: BrowserInfo | null;
  chrome: ChromeStatus | null;
  chromeTabs: ChromeTab[];
  chromeBusy: boolean;
  /** last error/info for the Browser view */
  notice: { text: string; error: boolean } | null;
  /** project id → detected dev servers, newest first */
  devServers: Record<string, DevServer[]>;
  /** bumped to focus the Browser view's URL box */
  urlInputTick: number;

  patchPage(tabId: string, patch: Partial<PageState>): void;
  dropPage(tabId: string): void;
  setNotice(text: string | null, error?: boolean): void;
  loadInfo(): Promise<void>;
  refreshChrome(tabsOnly?: boolean): Promise<void>;
  setChromeBusy(v: boolean): void;
  requestUrlInput(): void;
}

const EMPTY_PAGE: PageState = { url: "", title: "", loading: false, favicon: null };

export const useBrowser = create<BrowserState>((set, get) => ({
  pages: {},
  info: null,
  chrome: null,
  chromeTabs: [],
  chromeBusy: false,
  notice: null,
  devServers: {},
  urlInputTick: 0,

  patchPage(tabId, patch) {
    set((s) => ({ pages: { ...s.pages, [tabId]: { ...EMPTY_PAGE, ...s.pages[tabId], ...patch } } }));
  },
  dropPage(tabId) {
    if (!get().pages[tabId]) return;
    set((s) => {
      const pages = { ...s.pages };
      delete pages[tabId];
      return { pages };
    });
  },
  setNotice(text, error = false) {
    set({ notice: text ? { text, error } : null });
  },
  async loadInfo() {
    try {
      set({ info: await browserApi.info() });
    } catch {
      /* backend not ready */
    }
  },
  async refreshChrome(tabsOnly = false) {
    try {
      if (!tabsOnly || !get().chrome) {
        const chrome = await browserApi.chromeStatus(chromePath());
        set({ chrome });
        if (!chrome.running) return set({ chromeTabs: [] });
      }
      if (get().chrome?.running) set({ chromeTabs: await browserApi.chromeTabs() });
    } catch {
      // the browser was closed: refresh the status once
      if (tabsOnly) {
        set({ chromeTabs: [] });
        try {
          set({ chrome: await browserApi.chromeStatus(chromePath()) });
        } catch {
          /* ignore */
        }
      }
    }
  },
  setChromeBusy(chromeBusy) {
    set({ chromeBusy });
  },
  requestUrlInput() {
    set((s) => ({ urlInputTick: s.urlInputTick + 1 }));
  },
}));

/** Project + tab of a built-in browser tab id. */
export function findBrowserTab(tabId: string) {
  const ws = useWorkspace.getState();
  for (const p of Object.values(ws.projects)) {
    const found = findEditorTab(p, tabId);
    if (found && found[1].kind === "browser") return { project: p, group: found[0], tab: found[1] };
  }
  return null;
}

// ---------------- backend events ----------------

interface PageEvent { tabId: string; url?: string | null; title?: string | null; loading?: boolean | null; favicon?: string | null }

let subscribed = false;
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  void listen<PageEvent>("browser-page", ({ payload: e }) => {
    const patch: Partial<PageState> = {};
    if (e.url != null) patch.url = e.url;
    if (e.title != null) patch.title = e.title;
    if (e.loading != null) patch.loading = e.loading;
    if (e.favicon != null) patch.favicon = e.favicon;
    if (e.loading) patch.error = null;
    useBrowser.getState().patchPage(e.tabId, patch);
    // The tab's path is its URL: restored on relaunch with the workspace.
    if (e.url && /^https?:/i.test(e.url)) {
      const found = findBrowserTab(e.tabId);
      if (found) useWorkspace.getState().setEditorTabPath(found.project.id, e.tabId, e.url);
    }
  });
  void listen<{ tabId: string; url: string }>("browser-new-window", ({ payload }) => {
    const found = findBrowserTab(payload.tabId);
    if (found) useWorkspace.getState().openEditor(found.project.id, payload.url, { kind: "browser", groupId: found.group.id });
  });
  void listen<{ tabId: string; path: string; success: boolean }>("browser-download", ({ payload }) => {
    useBrowser.getState().patchPage(payload.tabId, { notice: payload.success ? `Downloaded ${payload.path.split("/").pop()} to Downloads` : "Download failed" });
  });
  void listen<{ paneId: string; url: string }>("dev-server", ({ payload }) => {
    const found = findPane(useWorkspace.getState(), payload.paneId);
    if (!found) return;
    const pid = found[0].id;
    useBrowser.setState((s) => {
      const list = (s.devServers[pid] ?? []).filter((d) => d.url !== payload.url);
      return { devServers: { ...s.devServers, [pid]: [{ url: payload.url, paneId: payload.paneId, at: Date.now() }, ...list].slice(0, 12) } };
    });
  });
  // A dev server's terminal exited: its URL is stale.
  void listen<{ paneId: string }>("pane-exit", ({ payload }) => {
    useBrowser.setState((s) => {
      let changed = false;
      const devServers: Record<string, DevServer[]> = {};
      for (const [pid, list] of Object.entries(s.devServers)) {
        devServers[pid] = list.filter((d) => d.paneId !== payload.paneId);
        changed ||= devServers[pid].length !== list.length;
      }
      return changed ? { devServers } : s;
    });
  });
}
subscribe();
