/// <reference types="vite/client" />

declare module "virtual:file-icons" {
  type M = Record<string, string>;
  interface Section { fileExtensions: M; fileNames: M; folderNames: M; folderNamesExpanded: M; languageIds: M }
  const data: Section & { light: Section; file: string; folder: string; folderExpanded: string };
  export default data;
}
