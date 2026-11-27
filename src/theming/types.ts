import type { TokenRule } from "./syntax";

export interface ColorThemeData {
  name?: string;
  /** VS Code: "dark" | "light" | "hc" | "hcLight" (also inferred from uiTheme) */
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: TokenRule[];
}

export interface ThemeEntry {
  id: string;
  label: string;
  uiTheme?: string | null;
  path: string;
  source: string;
}

export interface ThemeCatalog {
  colorThemes: ThemeEntry[];
  iconThemes: ThemeEntry[];
}

export interface IconDef {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontId?: string;
  fontSize?: string;
}

export interface IconMaps {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

export interface IconThemeData extends IconMaps {
  iconDefinitions?: Record<string, IconDef>;
  fonts?: { id: string; src: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  light?: IconMaps;
}
