import icons from "virtual:file-icons";
import { useIsDark } from "../theme";

// Extensions Material Icon Theme only maps via VS Code language ids.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", js: "javascript", cjs: "javascript", mjs: "javascript",
  py: "python", rs: "rust", go: "go", md: "markdown", json: "json", css: "css", html: "html", htm: "html",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", yml: "yaml", yaml: "yaml", xml: "xml", sql: "sql",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", java: "java", rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
};

function lookup(map: Record<string, string>, light: Record<string, string>, key: string, isLight: boolean) {
  return (isLight && light[key]) || map[key];
}

export function fileIconName(name: string, isLight: boolean): string {
  const lower = name.toLowerCase();
  const L = icons.light;
  const byName = lookup(icons.fileNames, L.fileNames, lower, isLight);
  if (byName) return byName;
  // Longest compound extension first: "foo.test.ts" → "test.ts" → "ts".
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const hit = lookup(icons.fileExtensions, L.fileExtensions, ext, isLight);
    if (hit) return hit;
  }
  const lang = EXT_LANG[parts[parts.length - 1]];
  const byLang = lang && lookup(icons.languageIds, L.languageIds, lang, isLight);
  return byLang || icons.file;
}

export function folderIconName(name: string, open: boolean, isLight: boolean): string {
  const lower = name.toLowerCase();
  const L = icons.light;
  return open
    ? lookup(icons.folderNamesExpanded, L.folderNamesExpanded, lower, isLight) || icons.folderExpanded
    : lookup(icons.folderNames, L.folderNames, lower, isLight) || icons.folder;
}

const iconUrl = (name: string) => `/file-icons/${name}.svg`;

export function FileIcon({ name, dir, open, size = 16 }: { name: string; dir?: boolean; open?: boolean; size?: number }) {
  const isLight = !useIsDark();
  const icon = dir ? folderIconName(name, !!open, isLight) : fileIconName(name, isLight);
  return <img className="file-icon" src={iconUrl(icon)} width={size} height={size} alt="" draggable={false} />;
}
