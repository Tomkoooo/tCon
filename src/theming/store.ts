// Settings + theming runtime. Source of truth: ~/.tcon/settings.json and keybindings.json
// (VS Code formats). Changes made in the UI are written back to those files; edits made in
// the files (in tCon's editor or anywhere else) are picked up live through the fs watcher.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type { FsChangedEvent } from "../types";
import { terminals } from "../terminal/registry";
import type { Keybinding } from "../commands";
import { BUILTIN_THEMES } from "./builtin";
import { parseJsonc, setJsoncKey } from "./jsonc";
import { BUILTIN_ICON_THEME_ID, builtinIconTheme, loadIconTheme, type LoadedIconTheme } from "./iconTheme";
import { computeSyntax, type TokenRule } from "./syntax";
import { computeTokens, type ThemeKind } from "./tokens";
import type { ColorThemeData, ThemeCatalog, ThemeEntry } from "./types";

export type Settings = Record<string, unknown>;

export const BUILTIN_ENTRIES: ThemeEntry[] = BUILTIN_THEMES.map((t) => ({
  id: t.name!,
  label: t.name!,
  uiTheme: t.type === "light" ? "vs" : "vs-dark",
  path: "",
  source: "tCon",
}));

interface ThemingState {
  dir: string | null;
  settingsText: string;
  settings: Settings;
  settingsError: string | null;
  keybindings: Keybinding[];
  keybindingsError: string | null;
  catalog: ThemeCatalog;
  systemDark: boolean;
  /** resolved active color theme */
  kind: ThemeKind;
  activeTheme: ThemeEntry | null;
  themeError: string | null;
  iconTheme: LoadedIconTheme | null;
  iconThemeError: string | null;

  init(): Promise<void>;
  ensureDir(): Promise<string | null>;
  rescan(): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  get<T>(key: string, fallback: T): T;
}

const CACHE_KEY = "tcon.themeVars";
let appliedVars: string[] = [];

function setVars(vars: Record<string, string>, kind: ThemeKind) {
  const root = document.documentElement;
  for (const k of appliedVars) if (!(k in vars)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = kind;
  root.dataset.themeKind = kind;
  appliedVars = Object.keys(vars);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ vars, kind }));
  } catch {
    /* storage unavailable */
  }
}

/** Apply the last theme synchronously at startup (avoids a flash of the default colors). */
export function applyCachedTheme() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const { vars, kind } = JSON.parse(raw) as { vars: Record<string, string>; kind: ThemeKind };
      return setVars(vars, kind);
    }
  } catch {
    /* fall through to the built-in theme */
  }
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const t = BUILTIN_THEMES[dark ? 0 : 1];
  const kind: ThemeKind = dark ? "dark" : "light";
  setVars({ ...computeTokens(t.colors ?? {}, kind), ...computeSyntax(t.tokenColors ?? []) }, kind);
}

function initialKind(): ThemeKind {
  try {
    const k = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null")?.kind;
    if (k === "dark" || k === "light") return k;
  } catch {
    /* ignore */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const kindOf = (data: ColorThemeData | null, entry: ThemeEntry | null): ThemeKind => {
  const t = (data?.type ?? "").toLowerCase();
  if (t === "light" || t === "hclight") return "light";
  if (t === "dark" || t === "hc" || t === "hcdark") return "dark";
  return entry?.uiTheme === "vs" || entry?.uiTheme === "hc-light" ? "light" : "dark";
};

const themeCache = new Map<string, ColorThemeData>();
let applyGen = 0;
let iconGen = 0;
let customCssOn = false;

const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);

export const useTheming = create<ThemingState>((set, get) => {
  const findTheme = (id: string): ThemeEntry | null => {
    const all = [...BUILTIN_ENTRIES, ...get().catalog.colorThemes];
    const lower = id.toLowerCase();
    return all.find((t) => t.id === id) ?? all.find((t) => t.label === id) ?? all.find((t) => t.id.toLowerCase() === lower || t.label.toLowerCase() === lower) ?? null;
  };

  const loadThemeData = async (entry: ThemeEntry): Promise<ColorThemeData> => {
    if (!entry.path) return BUILTIN_THEMES.find((t) => t.name === entry.id)!;
    const cached = themeCache.get(entry.path);
    if (cached) return cached;
    const data = await api.themeLoad(entry.path);
    themeCache.set(entry.path, data);
    return data;
  };

  /** Resolve + apply the color theme, fonts and terminal options from current settings. */
  const applyTheme = async () => {
    const gen = ++applyGen;
    const { settings, systemDark } = get();
    const auto = settings["window.autoDetectColorScheme"] !== false;
    const wanted = auto
      ? systemDark
        ? str(settings["workbench.preferredDarkColorTheme"], "tCon Dark")
        : str(settings["workbench.preferredLightColorTheme"], "tCon Light")
      : str(settings["workbench.colorTheme"], "tCon Dark");
    let entry = findTheme(wanted);
    let data: ColorThemeData | null = null;
    let error: string | null = null;
    if (!entry) error = `Color theme "${wanted}" not found.`;
    else {
      try {
        data = await loadThemeData(entry);
      } catch (e) {
        error = `Couldn't load "${entry.label}": ${String(e)}`;
      }
    }
    if (gen !== applyGen) return;
    if (!data) {
      entry = BUILTIN_ENTRIES[auto && !systemDark ? 1 : 0];
      data = await loadThemeData(entry);
    }
    const kind = kindOf(data, entry);

    // colorCustomizations: global keys + "[Theme Name]" scoped blocks
    const custom = (settings["workbench.colorCustomizations"] ?? {}) as Record<string, unknown>;
    const scoped = (o: Record<string, unknown>) =>
      Object.assign({}, ...[`[${entry!.label}]`, `[${entry!.id}]`].map((k) => (o[k] && typeof o[k] === "object" ? o[k] : {})));
    const plain = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !k.startsWith("[") && typeof v === "string"));
    const colors = { ...(data.colors ?? {}), ...plain(custom), ...plain(scoped(custom)) } as Record<string, string>;

    const tokenCustom = (settings["editor.tokenColorCustomizations"] ?? {}) as Record<string, unknown>;
    const rules: TokenRule[] = [...(Array.isArray(data.tokenColors) ? data.tokenColors : []), ...customRules(tokenCustom), ...customRules(scoped(tokenCustom))];

    const vars: Record<string, string> = { ...computeTokens(colors, kind), ...computeSyntax(rules) };
    const font = (key: string, d: string) => str(settings[key], d);
    vars["--editor-font"] = font("editor.fontFamily", 'var(--font-mono)');
    vars["--editor-font-size"] = `${num(settings["editor.fontSize"], 13)}px`;
    const lh = num(settings["editor.lineHeight"], 1.5);
    vars["--editor-line-height"] = lh > 4 ? `${lh}px` : String(lh || 1.5);
    vars["--ui-font-size"] = `${num(settings["workbench.fontSize"], 13)}px`;
    setVars(vars, kind);
    set({ kind, activeTheme: entry, themeError: error });

    terminals.applySettings({
      fontFamily: font("terminal.integrated.fontFamily", '"SF Mono", Menlo, Monaco, monospace'),
      fontSize: num(settings["terminal.integrated.fontSize"], 13),
      lineHeight: num(settings["terminal.integrated.lineHeight"], 1.15),
      cursorBlink: settings["terminal.integrated.cursorBlink"] !== false,
      cursorStyle: (["block", "underline", "bar"].includes(String(settings["terminal.integrated.cursorStyle"])) ? settings["terminal.integrated.cursorStyle"] : "block") as "block" | "underline" | "bar",
      scrollback: num(settings["terminal.integrated.scrollback"], 15000),
    });
    terminals.applyTheme();
  };

  const applyIconTheme = async () => {
    const gen = ++iconGen;
    const raw = get().settings["workbench.iconTheme"];
    const id = raw === null || raw === "" ? null : str(raw, BUILTIN_ICON_THEME_ID);
    if (!id) return set({ iconTheme: null, iconThemeError: null });
    if (get().iconTheme?.id === id) return;
    if (id === BUILTIN_ICON_THEME_ID) return set({ iconTheme: builtinIconTheme(), iconThemeError: null });
    const entry = get().catalog.iconThemes.find((t) => t.id === id || t.label === id);
    if (!entry) return set({ iconTheme: builtinIconTheme(), iconThemeError: `Icon theme "${id}" not found.` });
    try {
      const loaded = await loadIconTheme(entry);
      if (gen === iconGen) set({ iconTheme: loaded, iconThemeError: null });
    } catch (e) {
      if (gen === iconGen) set({ iconTheme: builtinIconTheme(), iconThemeError: `Couldn't load icon theme: ${String(e)}` });
    }
  };

  const applyCustomCss = async () => {
    const on = get().settings["tcon.customCss"] === true;
    let el = document.getElementById("tcon-custom-css") as HTMLStyleElement | null;
    if (!on) {
      el?.remove();
      customCssOn = false;
      return;
    }
    const css = await api.configRead("custom.css").catch(() => "");
    if (!el) {
      el = document.createElement("style");
      el.id = "tcon-custom-css";
      document.head.appendChild(el);
    }
    el.textContent = css;
    customCssOn = true;
  };

  const loadSettings = async () => {
    const text = await api.configRead("settings.json").catch(() => "");
    try {
      set({ settingsText: text, settings: parseJsonc<Settings>(text) ?? {}, settingsError: null });
    } catch (e) {
      // keep the last good settings; report the error
      set({ settingsText: text, settingsError: `settings.json: ${String(e)}` });
    }
  };

  const loadKeybindings = async () => {
    const text = await api.configRead("keybindings.json").catch(() => "");
    try {
      const parsed = parseJsonc<unknown>(text);
      set({ keybindings: Array.isArray(parsed) ? (parsed as Keybinding[]) : [], keybindingsError: null });
    } catch (e) {
      set({ keybindingsError: `keybindings.json: ${String(e)}` });
    }
  };

  const applyAll = async () => {
    await Promise.all([applyTheme(), applyIconTheme(), applyCustomCss()]);
  };

  return {
    dir: null,
    settingsText: "",
    settings: {},
    settingsError: null,
    keybindings: [],
    keybindingsError: null,
    catalog: { colorThemes: [], iconThemes: [] },
    systemDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    kind: initialKind(),
    activeTheme: null,
    themeError: null,
    iconTheme: builtinIconTheme(),
    iconThemeError: null,

    async init() {
      const dir = await get().ensureDir();
      await Promise.all([loadSettings(), loadKeybindings()]);
      await migrateLegacyTheme(get().setSetting);
      // Built-in themes apply immediately; the catalog scan (disk) follows.
      await applyAll();
      await get().rescan();

      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        set({ systemDark: e.matches });
        void applyTheme();
      });
      if (!dir) return;
      api.fsWatch(dir).catch(() => {});
      void listen<FsChangedEvent>("fs-changed", async ({ payload }) => {
        if (payload.root.replace(/\/+$/, "") !== dir) return;
        const rel = payload.paths.map((p) => p.slice(dir.length + 1));
        if (rel.some((p) => p === "settings.json")) {
          await loadSettings();
          await applyAll();
        }
        if (rel.some((p) => p === "keybindings.json")) await loadKeybindings();
        if (rel.some((p) => p === "custom.css") && customCssOn) await applyCustomCss();
        if (rel.some((p) => p.startsWith("themes/") || p.startsWith("extensions/"))) {
          themeCache.clear();
          await get().rescan();
        }
      }).catch(() => {});
    },

    async ensureDir() {
      if (get().dir) return get().dir;
      try {
        const dir = (await api.configInit()).replace(/\/+$/, "");
        set({ dir });
        return dir;
      } catch {
        return null;
      }
    },

    async rescan() {
      try {
        set({ catalog: await api.themesScan() });
      } catch {
        /* backend unavailable */
      }
      // the wanted theme may only now be known
      set({ iconTheme: get().iconTheme?.id === BUILTIN_ICON_THEME_ID ? get().iconTheme : null });
      await applyAll();
    },

    async setSetting(key, value) {
      const text = setJsoncKey(get().settingsText, key, value);
      set({ settingsText: text, settings: { ...get().settings, [key]: value }, settingsError: null });
      await api.configWrite("settings.json", text).catch((e) => set({ settingsError: String(e) }));
      await applyAll();
    },

    get(key, fallback) {
      const v = get().settings[key];
      return v === undefined ? fallback : (v as typeof fallback);
    },
  };
});

/** editor.tokenColorCustomizations → TextMate rules (incl. the comments/strings/… shorthands). */
function customRules(o: Record<string, unknown>): TokenRule[] {
  const rules: TokenRule[] = [];
  const short: Record<string, string> = {
    comments: "comment", strings: "string", keywords: "keyword, storage", numbers: "constant.numeric",
    types: "entity.name.type, support.type", functions: "entity.name.function, support.function", variables: "variable",
  };
  for (const [k, scope] of Object.entries(short)) {
    const val = o[k];
    if (typeof val === "string") rules.push({ scope, settings: { foreground: val } });
    else if (val && typeof val === "object") rules.push({ scope, settings: val as TokenRule["settings"] });
  }
  if (Array.isArray(o.textMateRules)) rules.push(...(o.textMateRules as TokenRule[]));
  return rules;
}

/** One-time: carry the old system/dark/light setting over into settings.json. */
async function migrateLegacyTheme(setSetting: (k: string, v: unknown) => Promise<void>) {
  try {
    const old = await api.settingGet("theme");
    if (old !== "dark" && old !== "light") return;
    await setSetting("window.autoDetectColorScheme", false);
    await setSetting("workbench.colorTheme", old === "dark" ? "tCon Dark" : "tCon Light");
    await api.settingSet("theme", "migrated");
  } catch {
    /* ignore */
  }
}
