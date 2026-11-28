// Pinned web apps: the data model and URL matching (no app imports, unit-tested in tests/pins.test.ts).
import type { IconName } from "../components/icons";

export const PINS_SETTING = "browser.pinnedApps";

/** Icons offered for a pin; "favicon" uses the page's own icon. */
export const PIN_ICONS = ["database", "server", "chart", "globe", "cloud", "board", "book", "mail", "terminal", "notes", "star", "target"] as const satisfies readonly IconName[];
export type PinIcon = (typeof PIN_ICONS)[number] | "favicon";

export interface PinnedApp {
  id: string;
  name: string;
  url: string;
  icon: PinIcon;
  color: string;
  /** the page's favicon when it was pinned (used by icon "favicon") */
  favicon?: string | null;
  /** project root this pin is limited to; empty = every project */
  project?: string | null;
}

const isIcon = (v: unknown): v is PinIcon => v === "favicon" || (PIN_ICONS as readonly string[]).includes(v as string);
const rootKey = (root: string) => root.replace(/\/+$/, "");

/** Validated pins from settings (hand-edited settings.json may hold anything). */
export function readPins(raw: unknown): PinnedApp[] {
  if (!Array.isArray(raw)) return [];
  const out: PinnedApp[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const url = typeof o.url === "string" && /^https?:\/\//i.test(o.url.trim()) && parse(o.url.trim()) ? o.url.trim() : null;
    if (!url) continue;
    out.push({
      id: typeof o.id === "string" && o.id ? o.id : url,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : url,
      url,
      icon: isIcon(o.icon) ? o.icon : "globe",
      color: typeof o.color === "string" && /^#[0-9a-f]{3,8}$/i.test(o.color) ? o.color : "",
      favicon: typeof o.favicon === "string" ? o.favicon : null,
      project: typeof o.project === "string" && o.project ? rootKey(o.project) : null,
    });
  }
  return out;
}

export const pinVisibleIn = (pin: PinnedApp, root: string) => !pin.project || pin.project === rootKey(root);

export function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Does a browser tab at `url` belong to the pin? Same origin, and inside the pin's path. */
export function pinMatches(pin: PinnedApp, url: string): boolean {
  const a = parse(pin.url);
  const b = parse(url);
  if (!a || !b || a.origin !== b.origin) return false;
  // "/adminer/?pgsql=…" pinned → any page under "/adminer/"; "/" pinned → the whole origin
  const base = a.pathname.replace(/[^/]*$/, "");
  return b.pathname.startsWith(base);
}

