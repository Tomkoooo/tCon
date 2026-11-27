// Pure helpers for the terminal split tree inside a terminal tab.
import type { LayoutNode } from "../types";

export const uid = () => crypto.randomUUID();

export type Leaf = Extract<LayoutNode, { type: "terminal" }>;

export function paneIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "split") return node.children.flatMap(paneIds);
  return [node.paneId];
}

const isPane = (n: LayoutNode, id: string) => n.type === "terminal" && n.paneId === id;

/** Insert `paneId` next to `targetId` (or at the root when the target isn't in the tree). */
export function insertPane(root: LayoutNode | null, targetId: string | null, paneId: string, direction: "row" | "column"): LayoutNode {
  const leaf: Leaf = { type: "terminal", paneId };
  if (!root) return leaf;
  if (!targetId || !paneIds(root).includes(targetId)) {
    if (root.type === "split" && root.direction === direction) {
      const children = [...root.children, leaf];
      return { ...root, children, sizes: equal(children.length) };
    }
    return { type: "split", id: uid(), direction, children: [root, leaf], sizes: [50, 50] };
  }
  const walk = (n: LayoutNode): LayoutNode => {
    if (isPane(n, targetId)) return { type: "split", id: uid(), direction, children: [n, leaf], sizes: [50, 50] };
    if (n.type !== "split") return n;
    const idx = n.children.findIndex((c) => isPane(c, targetId));
    if (idx >= 0 && n.direction === direction) {
      const children = [...n.children];
      children.splice(idx + 1, 0, leaf);
      return { ...n, children, sizes: equal(children.length) };
    }
    return { ...n, children: n.children.map(walk) };
  };
  return walk(root);
}

export function removePane(root: LayoutNode | null, id: string): LayoutNode | null {
  if (!root) return null;
  if (isPane(root, id)) return null;
  if (root.type !== "split") return root;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((c, i) => {
    const r = removePane(c, id);
    if (r) {
      kept.push(r);
      sizes.push(root.sizes[i] ?? 0);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...root, children: kept, sizes: sizes.map((s) => (s / total) * 100) };
}

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type !== "split") return root;
  if (root.id === splitId) return { ...root, sizes };
  return { ...root, children: root.children.map((c) => setSizes(c, splitId, sizes)) };
}

/** Drop leaves that don't satisfy `keep` (used to migrate legacy layouts with editor leaves). */
export function sanitize(node: unknown, keep: (paneId: string) => boolean): LayoutNode | null {
  const n = node as { type?: string; paneId?: string; id?: string; direction?: "row" | "column"; children?: unknown[]; sizes?: number[] } | null;
  if (!n) return null;
  if (n.type === "terminal") return n.paneId && keep(n.paneId) ? { type: "terminal", paneId: n.paneId } : null;
  if (n.type !== "split" || !Array.isArray(n.children)) return null;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const r = sanitize(c, keep);
    if (r) {
      kept.push(r);
      sizes.push(n.sizes?.[i] ?? 1);
    }
  });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { type: "split", id: n.id ?? uid(), direction: n.direction ?? "row", children: kept, sizes: sizes.map((s) => (s / total) * 100) };
}

export function equal(n: number) {
  return Array.from({ length: n }, () => 100 / n);
}
