// Pinned web apps: built-in browser pages pinned to the activity bar with an icon and a color
// (a self-hosted Compass web, Adminer, pgweb, Grafana…). Kept in ~/.tcon/settings.json →
// browser.pinnedApps, so they're shared by every project unless limited to one project root.
// The built-in browser's persistent store keeps their logins between launches.
import { create } from "zustand";
import { hostOf } from "./api";
import { PALETTE, useWorkspace } from "../store/workspace";
import { useTheming } from "../theming/store";
import type { Project } from "../types";
import { useBrowser } from "./store";
import { PINS_SETTING, pinMatches, pinVisibleIn, readPins as parsePins, type PinIcon, type PinnedApp } from "./pinModel";

export { PIN_ICONS, PINS_SETTING, pinMatches, type PinIcon, type PinnedApp } from "./pinModel";

/** Validated pins from settings. */
export const readPins = (raw: unknown = useTheming.getState().settings[PINS_SETTING]) => parsePins(raw);

/** Pins shown for a project root (global ones + the project's own). */
export function usePinnedApps(root: string): PinnedApp[] {
  const raw = useTheming((s) => s.settings[PINS_SETTING]);
  return readPins(raw).filter((p) => pinVisibleIn(p, root));
}

function writePins(pins: PinnedApp[]) {
  const clean = pins.map(({ id, name, url, icon, color, favicon, project }) => ({
    id, name, url, icon, ...(color ? { color } : {}), ...(favicon ? { favicon } : {}), ...(project ? { project } : {}),
  }));
  return useTheming.getState().setSetting(PINS_SETTING, clean);
}

export function savePin(pin: PinnedApp) {
  const pins = readPins();
  const i = pins.findIndex((p) => p.id === pin.id);
  if (i >= 0) pins[i] = pin;
  else pins.push(pin);
  return writePins(pins);
}

export function removePin(id: string) {
  return writePins(readPins().filter((p) => p.id !== id));
}

/** Move a pin up/down among the pins visible in `root`. */
export function movePin(id: string, delta: -1 | 1, root: string) {
  const pins = readPins();
  const visible = pins.filter((p) => pinVisibleIn(p, root));
  const vi = visible.findIndex((p) => p.id === id);
  const other = visible[vi + delta];
  if (vi < 0 || !other) return;
  const a = pins.findIndex((p) => p.id === id);
  const b = pins.findIndex((p) => p.id === other.id);
  [pins[a], pins[b]] = [pins[b], pins[a]];
  return writePins(pins);
}

// ---------------- opening ----------------

/** The project's open browser tab for a pin (the active one first). */
export function findPinTab(project: Project, pin: PinnedApp): { groupId: string; tabId: string } | null {
  let found: { groupId: string; tabId: string } | null = null;
  for (const g of project.editorGroups) {
    for (const t of g.tabs) {
      if (t.kind !== "browser" || !pinMatches(pin, t.path)) continue;
      if (g.activeTabId === t.id && g.id === project.activeEditorGroupId) return { groupId: g.id, tabId: t.id };
      found ??= { groupId: g.id, tabId: t.id };
    }
  }
  return found;
}

/** Is the pin's page the tab in front of the active editor group? */
export function isPinActive(project: Project, pin: PinnedApp): boolean {
  const g = project.editorGroups.find((x) => x.id === project.activeEditorGroupId);
  const t = g?.tabs.find((x) => x.id === g.activeTabId);
  return !!t && t.kind === "browser" && pinMatches(pin, t.path);
}

/** Focus the pin's tab if it's open in the project, else open it in a new browser tab. */
export function openPin(projectId: string, pin: PinnedApp) {
  const ws = useWorkspace.getState();
  const project = ws.projects[projectId];
  if (!project) return;
  const open = findPinTab(project, pin);
  if (open) ws.setActiveEditorTab(projectId, open.groupId, open.tabId);
  else ws.openEditor(projectId, pin.url, { kind: "browser" });
}

// ---------------- pin dialog ----------------

interface PinDialogState {
  /** the pin being added/edited, with the project it was opened from */
  draft: { pin: PinnedApp; projectRoot: string; isNew: boolean } | null;
  close(): void;
}

export const usePinDialog = create<PinDialogState>((set) => ({
  draft: null,
  close: () => set({ draft: null }),
}));

export function editPin(pin: PinnedApp, projectRoot: string) {
  usePinDialog.setState({ draft: { pin, projectRoot, isNew: !readPins().some((p) => p.id === pin.id) } });
}

/** Open the pin dialog for a new pin (prefilled from a page). */
export function newPin(projectRoot: string, page?: { url?: string; title?: string; favicon?: string | null }) {
  const url = page?.url && /^https?:/i.test(page.url) ? page.url : "";
  const existing = url ? readPins().find((p) => p.url === url) : undefined;
  if (existing) return editPin(existing, projectRoot);
  const title = page?.title?.trim() ?? "";
  editPin(
    {
      id: crypto.randomUUID(),
      name: title.length > 0 && title.length <= 40 ? title : url ? hostOf(url) : "",
      url,
      icon: guessIcon(url, title),
      color: PALETTE[0],
      favicon: page?.favicon ?? null,
      project: null,
    },
    projectRoot,
  );
}

/** A database-looking page gets the database icon. */
function guessIcon(url: string, title: string): PinIcon {
  const hay = `${url} ${title}`.toLowerCase();
  if (/mongo|compass|adminer|pgweb|pgadmin|phpmyadmin|cloudbeaver|sql|redis|database|\bdb\b/.test(hay)) return "database";
  if (/grafana|metabase|kibana|dashboard|analytics/.test(hay)) return "chart";
  return "globe";
}

/** "Browser: Pin Page to Sidebar…": the active browser tab's page, or an empty pin. */
export function pinActivePage() {
  const ws = useWorkspace.getState();
  const project = ws.activeProjectId ? ws.projects[ws.activeProjectId] : null;
  if (!project) return;
  const g = project.editorGroups.find((x) => x.id === project.activeEditorGroupId);
  const t = g?.tabs.find((x) => x.id === g.activeTabId);
  if (t?.kind !== "browser") return newPin(project.rootPath);
  const page = useBrowser.getState().pages[t.id];
  newPin(project.rootPath, { url: page?.url || t.path, title: page?.title, favicon: page?.favicon });
}
