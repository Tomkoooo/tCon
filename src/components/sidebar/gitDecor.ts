import type { GitFileStatus, GitStatus } from "../../types";

export type DecorKind = "modified" | "added" | "untracked" | "deleted" | "renamed" | "conflict";

export interface Decor {
  kind: DecorKind;
  letter: string;
}

export function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

export function joinPath(root: string, rel: string): string {
  return `${trimSlash(root)}/${rel.replace(/^\/+/, "")}`;
}

export function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function baseName(p: string): string {
  const t = trimSlash(p);
  return t.slice(t.lastIndexOf("/") + 1);
}

export function decorFor(f: GitFileStatus): Decor {
  const i = f.index;
  const w = f.worktree;
  if (i === "?" || w === "?") return { kind: "untracked", letter: "U" };
  if (i === "U" || w === "U" || (i === "A" && w === "A") || (i === "D" && w === "D")) {
    return { kind: "conflict", letter: "!" };
  }
  const c = w !== " " ? w : i;
  switch (c) {
    case "A": return { kind: "added", letter: "A" };
    case "D": return { kind: "deleted", letter: "D" };
    case "R": return { kind: "renamed", letter: "R" };
    case "C": return { kind: "added", letter: "C" };
    default: return { kind: "modified", letter: "M" };
  }
}

export interface DecorIndex {
  files: Map<string, Decor>;
  /** directories that contain at least one changed path (absolute) */
  dirs: Set<string>;
  /** untracked directories reported by git as "dir/" (absolute, no trailing slash) */
  untrackedDirs: string[];
}

export function buildDecorIndex(status: GitStatus | null | undefined): DecorIndex {
  const files = new Map<string, Decor>();
  const dirs = new Set<string>();
  const untrackedDirs: string[] = [];
  if (!status || !status.isRepo || !status.root) return { files, dirs, untrackedDirs };
  const gitRoot = trimSlash(status.root);
  for (const f of status.files) {
    const isDir = f.path.endsWith("/");
    // Renames may be reported as "old -> new".
    const rel = f.path.includes(" -> ") ? f.path.split(" -> ")[1] : f.path;
    const abs = joinPath(gitRoot, trimSlash(rel));
    const d = decorFor(f);
    files.set(abs, d);
    if (isDir) untrackedDirs.push(abs);
    let p = parentDir(abs);
    while (p.length >= gitRoot.length && !dirs.has(p)) {
      dirs.add(p);
      if (p === gitRoot || p === "/") break;
      p = parentDir(p);
    }
  }
  return { files, dirs, untrackedDirs };
}

export function lookupDecor(idx: DecorIndex, path: string): Decor | undefined {
  const d = idx.files.get(path);
  if (d) return d;
  for (const u of idx.untrackedDirs) {
    if (path.startsWith(u + "/")) return { kind: "untracked", letter: "U" };
  }
  return undefined;
}
