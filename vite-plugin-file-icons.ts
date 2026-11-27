// Serves Material Icon Theme (the popular VS Code icon theme, MIT) SVGs at /file-icons/<name>.svg
// and exposes a trimmed name-mapping manifest as `virtual:file-icons`.
// @ts-expect-error no @types/node
import fs from "node:fs";
// @ts-expect-error no @types/node
import path from "node:path";
import type { Plugin } from "vite";

const PKG = "node_modules/material-icon-theme/dist";
const VIRTUAL = "virtual:file-icons";
const RESOLVED = "\0" + VIRTUAL;
const URL_PREFIX = "/file-icons/";

type Defs = Record<string, { iconPath: string }>;
type Map = Record<string, string>;

export function fileIcons(): Plugin {
  let root = "";
  let manifest: Record<string, unknown> & { iconDefinitions: Defs; light: Record<string, Map> };
  const fileFor = (name: string) => {
    const def = manifest.iconDefinitions[name];
    return def ? path.resolve(root, PKG, def.iconPath) : null;
  };
  return {
    name: "tcon-file-icons",
    configResolved(cfg) {
      root = cfg.root;
      manifest = JSON.parse(fs.readFileSync(path.resolve(root, PKG, "material-icons.json"), "utf8"));
    },
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const pick = (src: Record<string, unknown>) => ({
        fileExtensions: src.fileExtensions ?? {},
        fileNames: src.fileNames ?? {},
        folderNames: src.folderNames ?? {},
        folderNamesExpanded: src.folderNamesExpanded ?? {},
        languageIds: src.languageIds ?? {},
      });
      const data = { ...pick(manifest), light: pick(manifest.light), file: manifest.file, folder: manifest.folder, folderExpanded: manifest.folderExpanded };
      return `export default ${JSON.stringify(data)};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith(URL_PREFIX)) return next();
        const name = decodeURIComponent(url.slice(URL_PREFIX.length).replace(/\.svg(\?.*)?$/, ""));
        const file = fileFor(name);
        if (!file || !fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "max-age=86400");
        res.end(fs.readFileSync(file));
      });
    },
    generateBundle() {
      for (const name of Object.keys(manifest.iconDefinitions)) {
        const file = fileFor(name);
        if (!file || !fs.existsSync(file)) continue;
        this.emitFile({ type: "asset", fileName: `file-icons/${name}.svg`, source: fs.readFileSync(file) });
      }
    },
  };
}
