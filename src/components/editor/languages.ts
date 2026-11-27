import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";

export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isMarkdownPath(path: string): boolean {
  const e = extOf(path);
  return e === "md" || e === "markdown" || e === "mdx";
}

export function languageFor(path: string): Extension {
  switch (extOf(path)) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "md":
    case "markdown":
    case "mdx":
      return markdown();
    case "rs":
      return rust();
    case "py":
      return python();
    case "json":
    case "jsonc":
      return json();
    case "css":
      return css();
    case "html":
    case "htm":
      return html();
    default:
      return [];
  }
}
