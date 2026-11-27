// Commands + keybindings (VS Code keybindings.json semantics: user entries are added on top of
// the defaults, "-command" removes a default binding, "when" supports editorFocus/terminalFocus).
import { hasEditors, useWorkspace } from "./store/workspace";
import { terminals } from "./terminal/registry";
import { closeEditors } from "./components/editor/editorActions";
import { useTheming } from "./theming/store";
import { refreshWorkspace } from "./refresh";
import { openBoard, quickAddTask, showTasksView } from "./tasks/actions";

export interface Keybinding { key: string; command: string; when?: string; args?: unknown }

interface Command {
  id: string;
  title: string;
  run(args?: unknown): void;
}

const ws = () => useWorkspace.getState();
const proj = () => {
  const s = ws();
  return s.activeProjectId ? s.projects[s.activeProjectId] : null;
};
const withProject = (fn: (id: string) => void) => () => {
  const p = proj();
  if (p) fn(p.id);
};

export function jumpToAttention() {
  const st = ws();
  const candidates: [string, string, number][] = [];
  for (const id of st.order) {
    const p = st.projects[id];
    for (const paneId of Object.keys(p.panes)) {
      const s = st.statuses[paneId];
      if (s && (s.state === "blocked" || (s.state === "done" && !s.seen) || (s.state === "error" && !s.seen)))
        candidates.push([id, paneId, s.state === "blocked" ? 0 : 1]);
    }
  }
  candidates.sort((a, b) => a[2] - b[2]);
  const target = candidates[0];
  if (!target) return;
  st.setActive(target[0]);
  st.focusPane(target[0], target[1]);
  requestAnimationFrame(() => terminals.focus(target[1]));
}

function activeEditorTab() {
  const p = proj();
  const g = p?.editorGroups.find((x) => x.id === p.activeEditorGroupId);
  return p && g?.activeTabId ? { p, g, tabId: g.activeTabId } : null;
}

const toggleView = (tab: "files" | "git" | "tasks") =>
  withProject((id) => {
    const p = ws().projects[id];
    ws().updateProject(id, { sidebarOpen: !(p.sidebarOpen && p.sidebarTab === tab), sidebarTab: tab });
  });

export const COMMANDS: Command[] = [
  { id: "tcon.newProject", title: "Open Project…", run: () => ws().setModal({ kind: "newProject" }) },
  { id: "tcon.refresh", title: "Refresh Files and Git Status", run: () => refreshWorkspace(proj()?.rootPath) },
  { id: "tcon.openSettings", title: "Settings", run: () => ws().setModal({ kind: "profiles" }) },
  { id: "tcon.manageAccounts", title: "Manage Claude Accounts…", run: () => ws().setModal({ kind: "profiles", section: "accounts" }) },
  { id: "tcon.openSettingsJson", title: "Open Settings (JSON)", run: () => void openConfigFile("settings.json") },
  { id: "tcon.openKeybindingsJson", title: "Open Keyboard Shortcuts (JSON)", run: () => void openConfigFile("keybindings.json") },
  { id: "tcon.jumpToAttention", title: "Jump to Session Needing Attention", run: jumpToAttention },
  {
    id: "tcon.selectProject",
    title: "Go to Project N (args: index, -1 = last)",
    run: (args) => {
      const st = ws();
      const n = typeof args === "number" ? args : 1;
      const id = n < 0 ? st.order[st.order.length + n] : st.order[n - 1];
      if (id) st.setActive(id);
    },
  },
  { id: "tcon.previousProject", title: "Previous Project", run: () => ws().cycleProject(-1) },
  { id: "tcon.nextProject", title: "Next Project", run: () => ws().cycleProject(1) },
  { id: "tcon.focusPreviousPane", title: "Focus Previous Terminal Split", run: () => ws().focusAdjacent(-1) },
  { id: "tcon.focusNextPane", title: "Focus Next Terminal Split", run: () => ws().focusAdjacent(1) },
  { id: "workbench.action.nextTab", title: "Next Tab (editor or terminal)", run: () => ws().cycleTab(1) },
  { id: "workbench.action.previousTab", title: "Previous Tab (editor or terminal)", run: () => ws().cycleTab(-1) },
  { id: "terminal.new", title: "New Terminal", run: withProject((id) => ws().addTerminal(id, { claude: false })) },
  { id: "terminal.newClaude", title: "New Claude Code Terminal", run: withProject((id) => ws().addTerminal(id, { claude: true })) },
  { id: "terminal.splitRight", title: "Split Terminal Right", run: withProject((id) => ws().addTerminal(id, { claude: false, split: "row" })) },
  { id: "terminal.splitDown", title: "Split Terminal Down", run: withProject((id) => ws().addTerminal(id, { claude: false, split: "column" })) },
  { id: "terminal.clear", title: "Clear Terminal", run: () => { const p = proj(); if (p?.focusedPaneId) terminals.clear(p.focusedPaneId); } },
  { id: "terminal.kill", title: "Kill Focused Terminal", run: () => { const p = proj(); if (p?.focusedPaneId) ws().closePane(p.id, p.focusedPaneId); } },
  {
    id: "tcon.close",
    title: "Close Editor or Terminal (by focus)",
    run: () => {
      const p = proj();
      if (!p) return;
      const ed = activeEditorTab();
      if (p.focusArea === "editor" && ed) void closeEditors(p.id, [ed.tabId]);
      else if (p.focusedPaneId) ws().closePane(p.id, p.focusedPaneId);
    },
  },
  { id: "workbench.action.closeActiveEditor", title: "Close Editor", run: () => { const ed = activeEditorTab(); if (ed) void closeEditors(ed.p.id, [ed.tabId]); } },
  { id: "workbench.action.splitEditor", title: "Move Editor to New Group (Split)", run: () => { const ed = activeEditorTab(); if (ed) ws().moveEditorTab(ed.p.id, ed.tabId, "new"); } },
  { id: "workbench.action.togglePanel", title: "Toggle Terminal Panel", run: withProject((id) => ws().togglePanel(id)) },
  { id: "workbench.action.toggleMaximizedPanel", title: "Maximize Terminal Panel", run: withProject((id) => ws().togglePanelMaximized(id)) },
  {
    id: "workbench.action.toggleSidebarVisibility",
    title: "Toggle Sidebar",
    run: withProject((id) => ws().updateProject(id, { sidebarOpen: !ws().projects[id].sidebarOpen })),
  },
  { id: "workbench.view.explorer", title: "Show Explorer", run: toggleView("files") },
  { id: "workbench.view.scm", title: "Show Source Control", run: toggleView("git") },
  { id: "workbench.action.reloadThemes", title: "Rescan Themes", run: () => void useTheming.getState().rescan() },
  { id: "tasks.quickAdd", title: "Tasks: Quick Add", run: quickAddTask },
  { id: "tasks.openBoard", title: "Tasks: Open Board", run: () => openBoard() },
  { id: "tasks.showView", title: "Tasks: Show Tasks View", run: () => showTasksView() },
];

export const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.id, c]));

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { key: "cmd+t", command: "tcon.newProject" },
  { key: "cmd+,", command: "tcon.openSettings" },
  { key: "cmd+shift+r", command: "tcon.refresh" },
  { key: "cmd+j", command: "tcon.jumpToAttention" },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: `cmd+${n}`, command: "tcon.selectProject", args: n })),
  { key: "cmd+9", command: "tcon.selectProject", args: -1 },
  { key: "cmd+shift+[", command: "tcon.previousProject" },
  { key: "cmd+shift+]", command: "tcon.nextProject" },
  { key: "cmd+alt+left", command: "tcon.focusPreviousPane" },
  { key: "cmd+alt+up", command: "tcon.focusPreviousPane" },
  { key: "cmd+alt+right", command: "tcon.focusNextPane" },
  { key: "cmd+alt+down", command: "tcon.focusNextPane" },
  { key: "ctrl+tab", command: "workbench.action.nextTab" },
  { key: "ctrl+shift+tab", command: "workbench.action.previousTab" },
  { key: "cmd+shift+t", command: "terminal.new" },
  { key: "ctrl+shift+`", command: "terminal.new" },
  { key: "cmd+shift+c", command: "terminal.newClaude" },
  { key: "cmd+d", command: "terminal.splitRight", when: "!editorFocus" },
  { key: "cmd+shift+d", command: "terminal.splitDown", when: "!editorFocus" },
  { key: "cmd+k", command: "terminal.clear", when: "!editorFocus" },
  { key: "cmd+w", command: "tcon.close" },
  { key: "cmd+\\", command: "workbench.action.splitEditor", when: "editorFocus" },
  { key: "ctrl+`", command: "workbench.action.togglePanel" },
  { key: "cmd+shift+j", command: "workbench.action.togglePanel" },
  { key: "cmd+shift+m", command: "workbench.action.toggleMaximizedPanel" },
  { key: "cmd+b", command: "workbench.action.toggleSidebarVisibility" },
  { key: "cmd+shift+e", command: "workbench.view.explorer" },
  { key: "cmd+shift+g", command: "workbench.view.scm" },
  { key: "cmd+shift+a", command: "tasks.quickAdd" },
  { key: "cmd+shift+b", command: "tasks.openBoard" },
];

// ---------------- key normalization ----------------

const MOD_ORDER = ["ctrl", "shift", "alt", "cmd"] as const;
const ALIASES: Record<string, string> = {
  meta: "cmd", command: "cmd", win: "cmd", super: "cmd", option: "alt", opt: "alt", control: "ctrl",
  esc: "escape", return: "enter", arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down",
  del: "delete", space: "space", backquote: "`", backslash: "\\",
};

/** Normalize "Cmd+Shift+T" → "ctrl?+shift+alt?+cmd+t" with a fixed modifier order. */
export function normalizeKey(key: string): string {
  const parts = key.toLowerCase().split("+").map((p) => p.trim());
  // "cmd++" style: an empty last part means the key is "+"
  if (key.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const mods = new Set<string>();
  let main = "";
  for (const raw of parts) {
    const p = ALIASES[raw] ?? raw;
    if ((MOD_ORDER as readonly string[]).includes(p)) mods.add(p);
    else if (p) main = p;
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), main].join("+");
}

const CODE_KEYS: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
  Quote: "'", Comma: ",", Period: ".", Slash: "/", IntlBackslash: "§", Space: "space", Enter: "enter", Tab: "tab",
  Escape: "escape", Backspace: "backspace", Delete: "delete", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up",
  ArrowDown: "down", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
};

/**
 * Key name of an event. Letters follow the keyboard layout (⌘Z is the key labelled Z, as on
 * macOS); digits and punctuation use the physical key so shortcuts work on non-US layouts.
 */
export function eventKey(e: KeyboardEvent): string {
  let main: string;
  if (/^[a-z]$/i.test(e.key)) main = e.key.toLowerCase();
  else if (e.altKey && /^Key[A-Z]$/.test(e.code)) main = e.code.slice(3).toLowerCase(); // ⌥ turns letters into symbols on macOS
  else if (/^Digit\d$/.test(e.code)) main = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) main = e.code.slice(6);
  else if (/^F\d{1,2}$/.test(e.code)) main = e.code.toLowerCase();
  else main = CODE_KEYS[e.code] ?? e.key.toLowerCase();
  const mods = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, cmd: e.metaKey };
  return [...MOD_ORDER.filter((m) => mods[m]), main].join("+");
}

/** Pretty macOS label: "cmd+shift+t" → "⇧⌘T". */
export function keyLabel(key: string): string {
  const parts = normalizeKey(key).split("+");
  const main = parts.pop() ?? "";
  const sym: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
  const names: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓", enter: "↵", tab: "⇥", escape: "⎋", backspace: "⌫", space: "Space" };
  return parts.map((m) => sym[m]).join("") + (names[main] ?? main.toUpperCase());
}

// ---------------- effective bindings ----------------

export function effectiveBindings(user: Keybinding[]): Keybinding[] {
  let list = DEFAULT_KEYBINDINGS.map((b) => ({ ...b, key: normalizeKey(b.key) }));
  const added: Keybinding[] = [];
  for (const u of user) {
    if (!u || typeof u.command !== "string") continue;
    if (u.command.startsWith("-")) {
      const cmd = u.command.slice(1);
      const k = u.key ? normalizeKey(u.key) : null;
      list = list.filter((b) => !(b.command === cmd && (!k || b.key === k) && (!u.when || b.when === u.when)));
    } else if (typeof u.key === "string") {
      added.push({ ...u, key: normalizeKey(u.key) });
    }
  }
  // User bindings take precedence (checked first), like VS Code.
  return [...added.reverse(), ...list];
}

/** Evaluate a tiny "when" expression: identifiers, !, && and ||. */
function evalWhen(expr: string | undefined, ctx: Record<string, boolean>): boolean {
  if (!expr) return true;
  return expr.split("||").some((alt) =>
    alt.split("&&").every((term) => {
      const t = term.trim();
      const neg = t.startsWith("!");
      const val = !!ctx[neg ? t.slice(1).trim() : t];
      return neg ? !val : val;
    }),
  );
}

export function whenContext(): Record<string, boolean> {
  const p = proj();
  const editorFocus = !!p && p.focusArea === "editor" && hasEditors(p);
  return { editorFocus, terminalFocus: !!p && !editorFocus, projectOpen: !!p };
}

/** Find the command bound to a key event, or null. */
export function resolveKey(e: KeyboardEvent, bindings: Keybinding[]): Keybinding | null {
  if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return null;
  const k = eventKey(e);
  const ctx = whenContext();
  return bindings.find((b) => b.key === k && evalWhen(b.when, ctx) && COMMAND_MAP.has(b.command)) ?? null;
}

/** Label of the first key bound to a command (for menus/tooltips), or undefined. */
export function keyFor(command: string, bindings: Keybinding[]): string | undefined {
  const b = bindings.find((x) => x.command === command);
  return b ? keyLabel(b.key) : undefined;
}

async function openConfigFile(name: "settings.json" | "keybindings.json") {
  const dir = await useTheming.getState().ensureDir();
  const p = proj();
  if (!p || !dir) {
    ws().setModal({ kind: "profiles" });
    return;
  }
  ws().setModal(null);
  ws().openEditor(p.id, `${dir}/${name}`);
}
