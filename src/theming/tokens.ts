// UI color tokens (CSS custom properties) and how they map from VS Code theme color ids.
// Each token reads, in order: `tcon.<token>` (tCon-specific override), the listed VS Code
// keys, then a fallback CSS expression (usually derived from other tokens via color-mix).
// Order matters: fallbacks may only reference tokens defined above them.

export type ThemeKind = "dark" | "light";

export interface TokenSpec {
  name: string; // CSS var without the leading --
  keys: string[];
  fallback: string | ((kind: ThemeKind) => string);
}

const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, var(--${a}) ${pct}%, var(--${b}))`;
const v = (name: string) => `var(--${name})`;
const byKind = (dark: string, light: string) => (k: ThemeKind) => (k === "dark" ? dark : light);

// VS Code's default terminal ANSI palette.
const ANSI: [string, string, string][] = [
  ["black", "#000000", "#000000"],
  ["red", "#cd3131", "#cd3131"],
  ["green", "#0dbc79", "#00bc00"],
  ["yellow", "#e5e510", "#949800"],
  ["blue", "#2472c8", "#0451a5"],
  ["magenta", "#bc3fbc", "#bc05bc"],
  ["cyan", "#11a8cd", "#0598bc"],
  ["white", "#e5e5e5", "#555555"],
  ["brightBlack", "#666666", "#666666"],
  ["brightRed", "#f14c4c", "#cd3131"],
  ["brightGreen", "#23d18b", "#14ce14"],
  ["brightYellow", "#f5f543", "#b5ba00"],
  ["brightBlue", "#3b8eea", "#0451a5"],
  ["brightMagenta", "#d670d6", "#bc05bc"],
  ["brightCyan", "#29b8db", "#0598bc"],
  ["brightWhite", "#e5e5e5", "#a5a5a5"],
];
export const ANSI_NAMES = ANSI.map(([n]) => n);
export const ansiVar = (name: string) => `ansi-${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;

export const TOKENS: TokenSpec[] = [
  // ---- base ----
  { name: "bg", keys: ["editor.background"], fallback: byKind("#1e1e1e", "#ffffff") },
  { name: "fg", keys: ["foreground", "editor.foreground"], fallback: byKind("#cccccc", "#3b3b3b") },
  { name: "bg-2", keys: ["sideBar.background", "editorGroupHeader.tabsBackground", "panel.background"], fallback: mix("fg", 4, "bg") },
  { name: "bg-3", keys: ["list.hoverBackground", "toolbar.hoverBackground"], fallback: mix("fg", 9, "bg-2") },
  // 62% / 75% of fg keeps dim text above 4.5:1 (WCAG AA) on the sidebar and hover backgrounds.
  { name: "fg-dim", keys: ["descriptionForeground", "tab.inactiveForeground"], fallback: (k) => (k === "dark" ? mix("fg", 62, "bg") : mix("fg", 75, "bg")) },
  { name: "border", keys: ["panel.border", "sideBar.border", "editorGroup.border", "contrastBorder"], fallback: mix("fg", 14, "bg") },
  { name: "accent", keys: ["focusBorder", "button.background", "activityBarBadge.background"], fallback: byKind("#3794ff", "#005fb8") },
  { name: "accent-fg", keys: ["button.foreground"], fallback: "#ffffff" },
  { name: "danger", keys: ["errorForeground", "editorError.foreground", "terminal.ansiRed"], fallback: byKind("#f14c4c", "#e51400") },
  { name: "warn", keys: ["editorWarning.foreground", "list.warningForeground"], fallback: byKind("#cca700", "#bf8803") },
  { name: "ok", keys: ["gitDecoration.addedResourceForeground", "terminal.ansiGreen"], fallback: byKind("#89d185", "#388a34") },
  { name: "working", keys: ["progressBar.background"], fallback: v("accent") },
  { name: "shadow", keys: ["widget.shadow"], fallback: byKind("rgba(0,0,0,.45)", "rgba(0,0,0,.18)") },
  { name: "scrollbar", keys: ["scrollbarSlider.background"], fallback: mix("fg", 22, "transparent") },
  { name: "scrollbar-hover", keys: ["scrollbarSlider.hoverBackground"], fallback: mix("fg", 35, "transparent") },

  // ---- areas ----
  { name: "titlebar-bg", keys: ["titleBar.activeBackground"], fallback: v("bg-2") },
  { name: "titlebar-fg", keys: ["titleBar.activeForeground"], fallback: v("fg") },
  { name: "activitybar-bg", keys: ["activityBar.background"], fallback: v("bg-2") },
  { name: "activitybar-fg", keys: ["activityBar.foreground"], fallback: v("fg") },
  { name: "activitybar-inactive-fg", keys: ["activityBar.inactiveForeground"], fallback: v("fg-dim") },
  { name: "activitybar-indicator", keys: ["activityBar.activeBorder"], fallback: v("accent") },
  { name: "activitybar-border", keys: ["activityBar.border"], fallback: v("border") },
  { name: "badge-bg", keys: ["activityBarBadge.background", "badge.background"], fallback: v("accent") },
  { name: "badge-fg", keys: ["activityBarBadge.foreground", "badge.foreground"], fallback: "#ffffff" },
  { name: "sidebar-bg", keys: ["sideBar.background"], fallback: v("bg-2") },
  { name: "sidebar-fg", keys: ["sideBar.foreground"], fallback: v("fg") },
  { name: "sidebar-header-fg", keys: ["sideBarTitle.foreground", "sideBarSectionHeader.foreground"], fallback: v("fg-dim") },
  { name: "sidebar-border", keys: ["sideBar.border"], fallback: v("border") },
  { name: "list-hover-bg", keys: ["list.hoverBackground"], fallback: v("bg-3") },
  { name: "list-active-bg", keys: ["list.activeSelectionBackground", "list.inactiveSelectionBackground"], fallback: mix("accent", 25, "bg-2") },
  { name: "list-active-fg", keys: ["list.activeSelectionForeground"], fallback: v("fg") },
  { name: "tabs-bg", keys: ["editorGroupHeader.tabsBackground"], fallback: v("bg-2") },
  { name: "tab-active-bg", keys: ["tab.activeBackground"], fallback: v("bg") },
  { name: "tab-active-fg", keys: ["tab.activeForeground"], fallback: v("fg") },
  { name: "tab-inactive-bg", keys: ["tab.inactiveBackground"], fallback: v("tabs-bg") },
  { name: "tab-inactive-fg", keys: ["tab.inactiveForeground"], fallback: v("fg-dim") },
  { name: "tab-border", keys: ["tab.border"], fallback: v("border") },
  { name: "panel-bg", keys: ["panel.background", "terminal.background"], fallback: v("bg") },
  { name: "panel-border", keys: ["panel.border"], fallback: v("border") },
  { name: "panel-header-bg", keys: ["tcon.panelHeader.background"], fallback: v("panel-bg") },
  { name: "statusbar-bg", keys: ["statusBar.background"], fallback: v("bg-2") },
  { name: "statusbar-fg", keys: ["statusBar.foreground"], fallback: v("fg-dim") },
  { name: "statusbar-border", keys: ["statusBar.border"], fallback: v("border") },
  { name: "input-bg", keys: ["input.background"], fallback: v("bg") },
  { name: "input-fg", keys: ["input.foreground"], fallback: v("fg") },
  { name: "input-border", keys: ["input.border"], fallback: v("border") },
  { name: "menu-bg", keys: ["menu.background", "editorWidget.background", "dropdown.background"], fallback: v("bg-2") },
  { name: "menu-fg", keys: ["menu.foreground", "editorWidget.foreground"], fallback: v("fg") },
  { name: "menu-selection-bg", keys: ["menu.selectionBackground", "list.activeSelectionBackground"], fallback: v("accent") },
  { name: "menu-selection-fg", keys: ["menu.selectionForeground", "list.activeSelectionForeground"], fallback: "#ffffff" },
  { name: "menu-border", keys: ["menu.border", "editorWidget.border"], fallback: v("border") },

  // ---- git / sync / claude ----
  { name: "git-modified", keys: ["gitDecoration.modifiedResourceForeground"], fallback: v("warn") },
  { name: "git-added", keys: ["gitDecoration.addedResourceForeground"], fallback: v("ok") },
  { name: "git-untracked", keys: ["gitDecoration.untrackedResourceForeground"], fallback: v("ok") },
  { name: "git-deleted", keys: ["gitDecoration.deletedResourceForeground"], fallback: v("danger") },
  { name: "git-conflict", keys: ["gitDecoration.conflictingResourceForeground"], fallback: v("danger") },
  { name: "sync-out", keys: [], fallback: "#e8a33d" },
  { name: "sync-in", keys: [], fallback: "#4fb5e8" },
  { name: "sync-local", keys: [], fallback: "#b884f0" },
  // commit graph lanes (VS Code's scmGraph.* colors)
  { name: "graph-1", keys: ["scmGraph.historyItemRefColor"], fallback: byKind("#59a4f9", "#1a85ff") },
  { name: "graph-2", keys: ["scmGraph.foreground1"], fallback: byKind("#ffb000", "#b07800") },
  { name: "graph-3", keys: ["scmGraph.foreground2"], fallback: byKind("#dc267f", "#c4166c") },
  { name: "graph-4", keys: ["scmGraph.foreground3"], fallback: byKind("#3fb950", "#1a7f37") },
  { name: "graph-5", keys: ["scmGraph.foreground5"], fallback: byKind("#b66dff", "#8250df") },
  { name: "graph-6", keys: ["scmGraph.foreground4"], fallback: byKind("#40b0a6", "#1b7c83") },
  { name: "claude", keys: [], fallback: "#d97757" },

  // ---- editor ----
  { name: "editor-bg", keys: ["editor.background"], fallback: v("bg") },
  { name: "editor-fg", keys: ["editor.foreground"], fallback: v("fg") },
  { name: "editor-line-number", keys: ["editorLineNumber.foreground"], fallback: v("fg-dim") },
  { name: "editor-line-number-active", keys: ["editorLineNumber.activeForeground"], fallback: v("editor-fg") },
  { name: "editor-cursor", keys: ["editorCursor.foreground"], fallback: v("editor-fg") },
  { name: "editor-selection", keys: ["editor.selectionBackground"], fallback: mix("accent", 32, "editor-bg") },
  { name: "editor-line-highlight", keys: ["editor.lineHighlightBackground"], fallback: mix("editor-fg", 5, "transparent") },
  { name: "editor-gutter-bg", keys: ["editorGutter.background"], fallback: v("editor-bg") },
  { name: "editor-match", keys: ["editor.selectionHighlightBackground", "editor.findMatchHighlightBackground"], fallback: mix("accent", 20, "transparent") },
  { name: "editor-bracket-match", keys: ["editorBracketMatch.background"], fallback: mix("ok", 25, "transparent") },
  { name: "editor-fold", keys: ["editorGutter.foldingControlForeground"], fallback: v("fg-dim") },

  // ---- terminal ----
  { name: "term-bg", keys: ["terminal.background", "panel.background"], fallback: v("editor-bg") },
  { name: "term-fg", keys: ["terminal.foreground"], fallback: v("fg") },
  { name: "term-cursor", keys: ["terminalCursor.foreground"], fallback: v("term-fg") },
  { name: "term-selection", keys: ["terminal.selectionBackground", "editor.selectionBackground"], fallback: mix("accent", 35, "term-bg") },
  ...ANSI.map(([n, dark, light]): TokenSpec => ({
    name: ansiVar(n),
    keys: [`terminal.ansi${n.charAt(0).toUpperCase()}${n.slice(1)}`],
    fallback: byKind(dark, light),
  })),
];

/** tCon-only color keys users can set in colorCustomizations (besides any VS Code key). */
export const TCON_KEYS = TOKENS.map((t) => `tcon.${t.name}`);

/** Compute CSS custom properties from a VS Code `colors` map. */
export function computeTokens(colors: Record<string, string>, kind: ThemeKind): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of TOKENS) {
    const val = [`tcon.${t.name}`, ...t.keys].map((k) => colors[k]).find((x) => typeof x === "string" && x.trim());
    out[`--${t.name}`] = val ?? (typeof t.fallback === "function" ? t.fallback(kind) : t.fallback);
  }
  return out;
}
