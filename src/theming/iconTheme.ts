// VS Code icon themes (file/folder icons). Supports SVG/PNG icon definitions and font-glyph
// icon themes (like Seti). The bundled Material Icon Theme is served from /file-icons/.
import { useEffect, useState } from "react";
import builtinMaterial from "virtual:file-icons";
import { api } from "../api";
import type { IconDef, IconMaps, IconThemeData, ThemeEntry } from "./types";

export const BUILTIN_ICON_THEME_ID = "material-icon-theme";
export const BUILTIN_ICON_THEME_LABEL = "Material Icon Theme (built-in)";

export interface LoadedIconTheme {
  id: string;
  label: string;
  data: IconThemeData;
  /** directory of the theme JSON; null = built-in (defs map to /file-icons/<id>.svg) */
  baseDir: string | null;
  /** fontId → CSS font-family + relative size */
  fonts: Record<string, { family: string; size?: string }>;
}

export function builtinIconTheme(): LoadedIconTheme {
  return { id: BUILTIN_ICON_THEME_ID, label: BUILTIN_ICON_THEME_LABEL, data: builtinMaterial as IconThemeData, baseDir: null, fonts: {} };
}

/** Resolve `rel` against `dir` (handles ./ and ../). */
export function joinPath(dir: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const parts = dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/") || "/";
}

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

let fontSeq = 0;

export async function loadIconTheme(entry: ThemeEntry): Promise<LoadedIconTheme> {
  const data = (await api.iconThemeLoad(entry.path)) as IconThemeData;
  const baseDir = dirname(entry.path);
  const fonts: LoadedIconTheme["fonts"] = {};
  for (const f of data.fonts ?? []) {
    const src = f.src?.[0];
    if (!src) continue;
    try {
      const url = await api.themeAsset(joinPath(baseDir, src.path));
      const family = `tcon-icons-${++fontSeq}`;
      const face = new FontFace(family, `url(${url})`, { weight: f.weight ?? "normal", style: f.style ?? "normal" });
      await face.load();
      document.fonts.add(face);
      fonts[f.id] = { family, size: f.size };
    } catch (e) {
      console.warn("icon font failed", f.id, e);
    }
  }
  return { id: entry.id, label: entry.label, data, baseDir, fonts };
}

// ---- language ids (icon themes like Seti map most files via VS Code language ids) ----

const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", cjs: "javascript", mjs: "javascript",
  jsx: "javascriptreact", json: "json", jsonc: "jsonc", json5: "json5", md: "markdown", markdown: "markdown", mdx: "mdx",
  css: "css", scss: "scss", sass: "sass", less: "less", html: "html", htm: "html", xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "ini", py: "python", pyi: "python", rs: "rust", go: "go", rb: "ruby", php: "php", java: "java", kt: "kotlin",
  kts: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp", fs: "fsharp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish", ps1: "powershell", bat: "bat", cmd: "bat",
  sql: "sql", lua: "lua", dart: "dart", r: "r", pl: "perl", pm: "perl", scala: "scala", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", clj: "clojure", coffee: "coffeescript", groovy: "groovy", gradle: "groovy", vue: "vue",
  svelte: "svelte", hbs: "handlebars", handlebars: "handlebars", pug: "jade", jade: "jade", cshtml: "razor", txt: "plaintext",
  log: "log", diff: "diff", patch: "diff", dockerfile: "dockerfile", tf: "terraform", graphql: "graphql", gql: "graphql",
  proto: "proto3", zig: "zig", nim: "nim", jl: "julia", ml: "ocaml", vim: "viml", tex: "latex", m: "objective-c", mm: "objective-cpp",
};
const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile", ".gitignore": "ignore", ".dockerignore": "ignore",
  ".npmignore": "ignore", "cmakelists.txt": "cmake", gemfile: "ruby", rakefile: "ruby", ".bashrc": "shellscript", ".zshrc": "shellscript",
};

function languageOf(lowerName: string): string | undefined {
  if (NAME_LANG[lowerName]) return NAME_LANG[lowerName];
  const dot = lowerName.lastIndexOf(".");
  return dot >= 0 ? EXT_LANG[lowerName.slice(dot + 1)] : undefined;
}

function pick(maps: IconMaps[], key: keyof IconMaps, name: string): string | undefined {
  for (const m of maps) {
    const table = m[key] as Record<string, string> | undefined;
    const hit = table?.[name];
    if (hit) return hit;
  }
  return undefined;
}

/** VS Code's lookup order: file name → longest extension → language id → default. */
export function resolveIconId(theme: LoadedIconTheme, name: string, opts: { dir?: boolean; open?: boolean; light?: boolean; root?: boolean }): string | undefined {
  const d = theme.data;
  const maps: IconMaps[] = opts.light && d.light ? [d.light, d] : [d];
  const lower = name.toLowerCase();
  if (opts.dir) {
    if (opts.root) {
      const r = opts.open ? d.rootFolderExpanded ?? d.rootFolder : d.rootFolder;
      if (r) return r;
    }
    return opts.open
      ? pick(maps, "folderNamesExpanded", lower) ?? d.folderExpanded ?? d.folder
      : pick(maps, "folderNames", lower) ?? d.folder;
  }
  const byName = pick(maps, "fileNames", lower) ?? pick(maps, "fileNames", name);
  if (byName) return byName;
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const hit = pick(maps, "fileExtensions", parts.slice(i).join("."));
    if (hit) return hit;
  }
  const lang = languageOf(lower);
  const byLang = lang ? pick(maps, "languageIds", lang) : undefined;
  return byLang ?? d.file;
}

export type ResolvedIcon =
  | { kind: "url"; url: string }
  | { kind: "asset"; path: string }
  | { kind: "glyph"; char: string; color?: string; family: string; size?: string };

export function resolveIcon(theme: LoadedIconTheme, name: string, opts: { dir?: boolean; open?: boolean; light?: boolean; root?: boolean }): ResolvedIcon | null {
  const id = resolveIconId(theme, name, opts);
  if (!id) return null;
  if (!theme.baseDir) return { kind: "url", url: `/file-icons/${id}.svg` };
  const def: IconDef | undefined = theme.data.iconDefinitions?.[id];
  if (!def) return null;
  if (def.iconPath) return { kind: "asset", path: joinPath(theme.baseDir, def.iconPath) };
  if (def.fontCharacter) {
    const fontId = def.fontId ?? theme.data.fonts?.[0]?.id;
    const font = fontId ? theme.fonts[fontId] : undefined;
    if (!font) return null;
    return { kind: "glyph", char: glyph(def.fontCharacter), color: def.fontColor, family: font.family, size: def.fontSize ?? font.size };
  }
  return null;
}

/** "\\E001" (as written in theme JSON) → the actual code point. */
function glyph(s: string): string {
  const m = s.match(/^\\+([0-9a-fA-F]{1,6})$/);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : s;
}

// ---- asset cache (icon files of external themes, as data: URLs) ----

const assets = new Map<string, string | Promise<string | null> | null>();

export function useAsset(path: string | null): string | null {
  const cached = path ? assets.get(path) : null;
  const [url, setUrl] = useState<string | null>(typeof cached === "string" ? cached : null);
  useEffect(() => {
    if (!path) return setUrl(null);
    const c = assets.get(path);
    if (typeof c === "string") return setUrl(c);
    let alive = true;
    let p = c instanceof Promise ? c : null;
    if (!p && c !== null) {
      p = api.themeAsset(path).then(
        (u) => (assets.set(path, u), u),
        () => (assets.set(path, null), null),
      );
      assets.set(path, p);
    }
    if (p) void p.then((u) => alive && setUrl(u));
    else setUrl(null);
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}
