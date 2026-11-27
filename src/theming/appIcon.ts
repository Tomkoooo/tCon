// Runtime app icon from the "app.icon" setting: "default", a built-in variant id, or an absolute
// path to an image. macOS swaps the Dock icon of the running app; other platforms set the window
// icon. The .app bundle (Finder) icon is never changed.
import { invoke } from "@tauri-apps/api/core";
import defaultSvg from "../../assets/icon.svg";
import classicSvg from "../../assets/icons/classic.svg";
import lightSvg from "../../assets/icons/light.svg";
import monoSvg from "../../assets/icons/mono.svg";

export const APP_ICON_KEY = "app.icon";

export const APP_ICON_VARIANTS: { id: string; label: string; src: string }[] = [
  { id: "default", label: "Default", src: defaultSvg },
  { id: "classic", label: "Classic", src: classicSvg },
  { id: "light", label: "Light", src: lightSvg },
  { id: "mono", label: "Graphite", src: monoSvg },
];

export const isBuiltinAppIcon = (spec: string) => APP_ICON_VARIANTS.some((v) => v.id === spec);

export const appIconSpec = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "default");

let applied: string | null = null;

/** Apply the icon if it changed since the last call (called whenever settings are applied). */
export async function applyAppIcon(value: unknown): Promise<string | null> {
  const spec = appIconSpec(value);
  if (spec === applied) return null;
  applied = spec;
  try {
    await invoke("app_set_icon", { spec });
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Data URL thumbnail for a user icon file (null for formats the webview can't show, e.g. ICNS). */
export const appIconPreview = (path: string) => invoke<string>("app_icon_preview", { path }).catch(() => null);
