// Minimal JSONC support: parse VS Code-style JSON with comments, and set a top-level key
// while keeping the user's comments and formatting.

/** Remove // and /* *\/ comments and trailing commas. */
export function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  const n = src.length;
  const skipWsAndComments = (j: number) => {
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === "/" && src[j + 1] === "/") {
        while (j < n && src[j] !== "\n") j++;
        continue;
      }
      if (src[j] === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j + 2);
        j = j < 0 ? n : j + 2;
        continue;
      }
      return j;
    }
  };
  while (i < n) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ",") {
      const j = skipWsAndComments(i + 1);
      if (src[j] !== "}" && src[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function parseJsonc<T = unknown>(src: string): T {
  const s = stripJsonc(src.replace(/^﻿/, "")).trim();
  return (s ? JSON.parse(s) : {}) as T;
}

/** Index of `pos`'s line start. */
const lineStart = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;

/** Is `pos` inside a // line comment or a /* block comment? */
function inComment(text: string, pos: number): boolean {
  const stripped = text.slice(0, pos);
  // block comment opened and not closed before pos
  const open = stripped.lastIndexOf("/*");
  if (open >= 0 && stripped.indexOf("*/", open) < 0) return true;
  const line = text.slice(lineStart(text, pos), pos);
  // a // outside of a string on this line (approximation: count quotes before it)
  const idx = line.indexOf("//");
  if (idx < 0) return false;
  const quotes = (line.slice(0, idx).match(/(?<!\\)"/g) ?? []).length;
  return quotes % 2 === 0;
}

/**
 * Set a top-level key in a JSONC object text. Scalar values are replaced in place;
 * new keys are appended before the closing brace. Falls back to a clean rewrite
 * if the result would not parse.
 */
export function setJsoncKey(text: string, key: string, value: unknown): string {
  const lit = JSON.stringify(value, null, 2).replace(/\n/g, "\n  ");
  const src = text.trim() ? text : "{\n}\n";
  const keyRe = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*`, "g");
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(src))) {
    if (inComment(src, m.index)) continue;
    const start = m.index + m[0].length;
    const rest = src.slice(start);
    const scalar = rest.match(/^("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    let end: number | null = scalar ? start + scalar[0].length : null;
    if (end === null && (rest[0] === "{" || rest[0] === "[")) end = start + matchBracket(rest);
    if (end === null) break;
    const next = src.slice(0, start) + lit + src.slice(end);
    return valid(next) ? next : rewrite(src, key, value);
  }
  // append
  const close = src.lastIndexOf("}");
  if (close < 0) return rewrite(src, key, value);
  let before = src.slice(0, close).replace(/\s+$/, "");
  // last significant char, ignoring trailing // comments
  const sig = stripJsonc(before).replace(/\s+$/, "");
  const needsComma = !(sig.endsWith("{") || sig.endsWith(","));
  if (needsComma) {
    // put the comma right after the last value (before any trailing comment on that line)
    const lastLine = before.slice(lineStart(before, before.length));
    const cIdx = lastLine.indexOf("//");
    if (cIdx >= 0 && inComment(before, lineStart(before, before.length) + cIdx + 1)) {
      const abs = lineStart(before, before.length) + cIdx;
      before = before.slice(0, abs).replace(/\s+$/, "") + ", " + before.slice(abs);
    } else before += ",";
  }
  const next = `${before}\n  ${JSON.stringify(key)}: ${lit}\n${src.slice(close)}`;
  return valid(next) ? next : rewrite(src, key, value);
}

function matchBracket(s: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

function valid(text: string): boolean {
  try {
    parseJsonc(text);
    return true;
  } catch {
    return false;
  }
}

function rewrite(text: string, key: string, value: unknown): string {
  let obj: Record<string, unknown> = {};
  try {
    obj = parseJsonc<Record<string, unknown>>(text) ?? {};
  } catch {
    /* unparsable: start over */
  }
  obj[key] = value;
  return JSON.stringify(obj, null, 2) + "\n";
}
