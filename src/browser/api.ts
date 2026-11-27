// Typed wrappers around the browser commands (src-tauri/src/browser).
import { invoke } from "@tauri-apps/api/core";

export type BrowserEngine = "builtin" | "chrome";
export type ChromeFamily = "chrome" | "canary" | "chromium" | "brave" | "edge" | "arc" | "other";

export interface ChromeBinary { family: ChromeFamily; name: string; path: string }
export interface ChromeStatus {
  running: boolean;
  port: number | null;
  endpoint: string | null;
  version: string | null;
  profileDir: string;
  profileExists: boolean;
  binary: ChromeBinary | null;
  detected: ChromeBinary[];
  /** Claude in Chrome native host manifests found for the default profiles */
  nativeHosts: string[];
  /** …and those already copied into the tCon profile */
  nativeHostsLinked: string[];
}
export interface ChromeTab { id: string; title: string; url: string; faviconUrl?: string | null }
export interface BrowserInfo { isolatedStore: boolean; storeLocation: string }
export interface ImportProfile { dir: string; name: string; user?: string | null }
export interface ImportSource {
  browser: string;
  family: ChromeFamily | null;
  userDataDir: string;
  profiles: ImportProfile[];
  running: boolean;
  supported: boolean;
  reason?: string | null;
}
export interface ImportResult { backup: string | null; bytes: number; files: number }
export interface Bounds { x: number; y: number; width: number; height: number }

export const browserApi = {
  info: () => invoke<BrowserInfo>("browser_info"),
  create: (tabId: string, url: string, b: Bounds, visible: boolean) => invoke<void>("browser_create", { tabId, url, ...b, visible }),
  setBounds: (tabId: string, b: Bounds, visible: boolean) => invoke<void>("browser_set_bounds", { tabId, ...b, visible }),
  navigate: (tabId: string, url: string) => invoke<void>("browser_navigate", { tabId, url }),
  action: (tabId: string, action: "back" | "forward" | "reload" | "stop" | "devtools" | "focus") => invoke<void>("browser_action", { tabId, action }),
  url: (tabId: string) => invoke<string>("browser_url", { tabId }),
  close: (tabId: string) => invoke<void>("browser_close", { tabId }),
  clearData: () => invoke<void>("browser_clear_data"),

  chromeStatus: (binary: string | null) => invoke<ChromeStatus>("chrome_status", { binary }),
  chromeLaunch: (binary: string | null, port: number, url: string | null) => invoke<ChromeStatus>("chrome_launch", { binary, port, url }),
  chromeTabs: () => invoke<ChromeTab[]>("chrome_tabs"),
  chromeOpen: (url: string) => invoke<ChromeTab>("chrome_open", { url }),
  chromeActivate: (id: string) => invoke<void>("chrome_activate", { id }),
  chromeClose: (id: string) => invoke<void>("chrome_close", { id }),
  chromeLinkNativeHosts: () => invoke<string[]>("chrome_link_native_hosts"),

  importSources: () => invoke<ImportSource[]>("browser_import_sources"),
  import: (userDataDir: string, profile: string) => invoke<ImportResult>("browser_import", { userDataDir, profile }),
};

/** "localhost:5173", "5173", "example.com/x" → a full URL; null if it isn't a web address. */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\/\S+$/i.test(s) || s === "about:blank") return s;
  if (/^\d{2,5}$/.test(s)) return `http://localhost:${s}`;
  if (/^:\d{2,5}(\/\S*)?$/.test(s)) return `http://localhost${s}`;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(:\d{1,5})?([/?#]\S*)?$/i.test(s)) return `http://${s.replace(/^0\.0\.0\.0/, "localhost")}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[\w.-]+:\d/.test(s)) return null; // another scheme (file:, javascript:, …)
  if (/^[\w-]+(\.[\w-]+)+(:\d{1,5})?([/?#]\S*)?$/.test(s)) return `https://${s}`;
  return null;
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
  }
}

export const isLoopback = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)(:|\/|$)/i.test(url);
