// Syntax colors: VS Code themes describe them as TextMate scope rules (`tokenColors`), while
// CodeMirror uses Lezer highlight tags. Each tag class below lists TextMate scopes to try, in
// priority order; the best matching theme rule wins (VS Code-style prefix matching).
// Results are written to CSS variables, so the CodeMirror highlight style itself never changes.
import { HighlightStyle } from "@codemirror/language";
import { tags as t, type Tag } from "@lezer/highlight";

export interface TokenRule {
  name?: string;
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}

interface SynClass {
  name: string;
  tags: Tag[];
  scopes: string[];
}

export const SYN_CLASSES: SynClass[] = [
  { name: "comment", tags: [t.comment, t.lineComment, t.blockComment, t.docComment], scopes: ["comment"] },
  { name: "keyword", tags: [t.keyword], scopes: ["keyword", "storage"] },
  { name: "control", tags: [t.controlKeyword], scopes: ["keyword.control", "keyword"] },
  { name: "decl", tags: [t.definitionKeyword, t.modifier], scopes: ["storage.type", "storage.modifier", "storage", "keyword"] },
  { name: "module", tags: [t.moduleKeyword], scopes: ["keyword.control.import", "keyword.control", "keyword"] },
  { name: "operator", tags: [t.operator, t.operatorKeyword, t.compareOperator, t.logicOperator, t.arithmeticOperator], scopes: ["keyword.operator"] },
  { name: "string", tags: [t.string, t.special(t.string), t.character, t.docString], scopes: ["string"] },
  { name: "regexp", tags: [t.regexp], scopes: ["string.regexp", "string"] },
  { name: "escape", tags: [t.escape], scopes: ["constant.character.escape", "constant.character", "string"] },
  { name: "number", tags: [t.number, t.integer, t.float], scopes: ["constant.numeric", "constant"] },
  { name: "bool", tags: [t.bool, t.null, t.atom], scopes: ["constant.language", "constant"] },
  { name: "constant", tags: [t.constant(t.variableName)], scopes: ["variable.other.constant", "constant.other", "variable"] },
  { name: "function", tags: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], scopes: ["entity.name.function", "support.function"] },
  { name: "macro", tags: [t.macroName], scopes: ["entity.name.function.macro", "entity.name.function"] },
  { name: "type", tags: [t.typeName], scopes: ["entity.name.type", "support.type", "storage.type"] },
  { name: "class", tags: [t.className, t.definition(t.className)], scopes: ["entity.name.type.class", "entity.name.class", "entity.name.type"] },
  { name: "namespace", tags: [t.namespace], scopes: ["entity.name.namespace", "entity.name.type.module", "entity.name.type"] },
  { name: "property", tags: [t.propertyName, t.definition(t.propertyName)], scopes: ["variable.other.property", "variable.other.object.property", "meta.object-literal.key", "support.type.property-name"] },
  { name: "variable", tags: [t.variableName], scopes: ["variable.other.readwrite", "variable"] },
  { name: "definition", tags: [t.definition(t.variableName)], scopes: ["variable.other.readwrite", "meta.definition.variable", "variable"] },
  { name: "self", tags: [t.self], scopes: ["variable.language"] },
  { name: "label", tags: [t.labelName], scopes: ["entity.name.label"] },
  { name: "tag", tags: [t.tagName], scopes: ["entity.name.tag"] },
  { name: "attribute", tags: [t.attributeName], scopes: ["entity.other.attribute-name"] },
  { name: "attribute-value", tags: [t.attributeValue], scopes: ["string.quoted", "string"] },
  { name: "punctuation", tags: [t.punctuation, t.separator, t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace], scopes: ["punctuation"] },
  { name: "meta", tags: [t.meta, t.annotation, t.processingInstruction], scopes: ["meta.decorator", "entity.name.function.decorator", "meta.preprocessor"] },
  { name: "heading", tags: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], scopes: ["markup.heading", "entity.name.section"] },
  { name: "link", tags: [t.link, t.url], scopes: ["markup.underline.link", "string.other.link"] },
  { name: "emphasis", tags: [t.emphasis], scopes: ["markup.italic"] },
  { name: "strong", tags: [t.strong], scopes: ["markup.bold"] },
  { name: "strike", tags: [t.strikethrough], scopes: ["markup.strikethrough"] },
  { name: "quote", tags: [t.quote], scopes: ["markup.quote"] },
  { name: "code", tags: [t.monospace], scopes: ["markup.inline.raw", "markup.fenced_code", "markup.raw"] },
  { name: "list", tags: [t.list], scopes: ["markup.list", "punctuation.definition.list"] },
  { name: "inserted", tags: [t.inserted], scopes: ["markup.inserted"] },
  { name: "deleted", tags: [t.deleted], scopes: ["markup.deleted"] },
  { name: "changed", tags: [t.changed], scopes: ["markup.changed"] },
  { name: "invalid", tags: [t.invalid], scopes: ["invalid"] },
];

const synVar = (name: string, prop: "c" | "fs" | "fw" | "td") => `--syn-${name}-${prop}`;

/** Static CodeMirror highlight style; colors come from the CSS variables set per theme. */
export const themedHighlightStyle = HighlightStyle.define(
  SYN_CLASSES.map((c) => ({
    tag: c.tags,
    color: `var(${synVar(c.name, "c")})`,
    fontStyle: `var(${synVar(c.name, "fs")})`,
    fontWeight: `var(${synVar(c.name, "fw")})`,
    textDecoration: `var(${synVar(c.name, "td")})`,
  })),
);

interface Selector { parts: number; index: number; fg?: string; fontStyle?: string }

/** Flatten rules to plain (non-descendant, non-exclusion) selectors. */
function selectors(rules: TokenRule[]): Map<string, Selector[]> {
  const map = new Map<string, Selector[]>();
  rules.forEach((r, index) => {
    if (!r?.settings || r.scope == null) return;
    const list = Array.isArray(r.scope) ? r.scope : String(r.scope).split(",");
    for (const raw of list) {
      const s = raw.trim();
      if (!s || s.includes(" ")) continue; // descendant and exclusion (" -x") selectors need context we don't have
      const arr = map.get(s) ?? [];
      arr.push({ parts: s.split(".").length, index, fg: r.settings.foreground, fontStyle: r.settings.fontStyle });
      map.set(s, arr);
    }
  });
  return map;
}

/** Best matching rule value for one TextMate scope (longest prefix, then latest rule). */
function match(map: Map<string, Selector[]>, scope: string, prop: "fg" | "fontStyle"): string | undefined {
  let best: Selector | undefined;
  const segs = scope.split(".");
  for (let n = segs.length; n > 0; n--) {
    const cand = map.get(segs.slice(0, n).join("."));
    if (!cand) continue;
    for (const s of cand) {
      if (s[prop] === undefined) continue;
      if (!best || s.parts > best.parts || (s.parts === best.parts && s.index > best.index)) best = s;
    }
    if (best) return best[prop];
  }
  return undefined;
}

/** CSS variables for every syntax class. */
export function computeSyntax(rules: TokenRule[]): Record<string, string> {
  const map = selectors(rules);
  const out: Record<string, string> = {};
  for (const c of SYN_CLASSES) {
    let fg: string | undefined;
    let fontStyle: string | undefined;
    for (const scope of c.scopes) {
      fg ??= match(map, scope, "fg");
      fontStyle ??= match(map, scope, "fontStyle");
      if (fg !== undefined && fontStyle !== undefined) break;
    }
    const fs = (fontStyle ?? "").split(/\s+/);
    out[synVar(c.name, "c")] = fg ?? "inherit";
    out[synVar(c.name, "fs")] = fs.includes("italic") ? "italic" : "normal";
    out[synVar(c.name, "fw")] = fs.includes("bold") || (fontStyle === undefined && (c.name === "heading" || c.name === "strong")) ? "bold" : "normal";
    out[synVar(c.name, "td")] = fs.includes("underline") || (fontStyle === undefined && c.name === "link") ? "underline" : fs.includes("strikethrough") || (fontStyle === undefined && c.name === "strike") ? "line-through" : "none";
  }
  // Default editor foreground from a scope-less rule (old-style themes).
  const global = rules.find((r) => r && r.scope == null && r.settings?.foreground);
  if (global?.settings?.foreground) out["--syn-default-fg"] = global.settings.foreground;
  return out;
}
