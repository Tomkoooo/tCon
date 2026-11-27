// Pure helpers for the split layout tree.
import type { LayoutNode } from "../types";

export const uid = () => crypto.randomUUID();

export type Leaf = Extract<LayoutNode, { type: "terminal" | "editor" }>;

export function leafKey(n: Leaf): string {
  return n.type === "terminal" ? n.paneId : n.id;
}

export function leaves(node: LayoutNode | null): Leaf[] {
  if (!node) return [];
  if (node.type === "split") return node.children.flatMap(leaves);
  return [node];
}

function matches(n: LayoutNode, key: string) {
  return n.type !== "split" && leafKey(n) === key;
}

/** Insert `leaf` next to the leaf identified by `targetKey` (or at root when null). */
export function insertLeaf(
  root: LayoutNode | null,
  targetKey: string | null,
  leaf: Leaf,
  direction: "row" | "column",
): LayoutNode {
  if (!root) return leaf;
  if (!targetKey || !leaves(root).some((l) => leafKey(l) === targetKey)) {
    // append to root
    if (root.type === "split" && root.direction === direction) {
      const children = [...root.children, leaf];
      return { ...root, children, sizes: equal(children.length) };
    }
    return { type: "split", id: uid(), direction, children: [root, leaf], sizes: [50, 50] };
  }
  const walk = (n: LayoutNode): LayoutNode => {
    if (matches(n, targetKey)) {
      return { type: "split", id: uid(), direction, children: [n, leaf], sizes: [50, 50] };
    }
    if (n.type !== "split") return n;
    const idx = n.children.findIndex((c) => matches(c, targetKey));
    if (idx >= 0 && n.direction === direction) {
      const children = [...n.children];
      children.splice(idx + 1, 0, leaf);
      return { ...n, children, sizes: equal(children.length) };
    }
    return { ...n, children: n.children.map(walk) };
  };
  return walk(root);
}

export function removeLeaf(root: LayoutNode | null, key: string): LayoutNode | null {
  if (!root) return null;
  if (matches(root, key)) return null;
  if (root.type !== "split") return root;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((c, i) => {
    const r = removeLeaf(c, key);
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

export function replaceLeaf(root: LayoutNode | null, key: string, next: Leaf): LayoutNode | null {
  if (!root) return null;
  if (matches(root, key)) return next;
  if (root.type !== "split") return root;
  return { ...root, children: root.children.map((c) => replaceLeaf(c, key, next) as LayoutNode) };
}

export function setSizes(root: LayoutNode | null, splitId: string, sizes: number[]): LayoutNode | null {
  if (!root || root.type !== "split") return root;
  if (root.id === splitId) return { ...root, sizes };
  return { ...root, children: root.children.map((c) => setSizes(c, splitId, sizes) as LayoutNode) };
}

function equal(n: number) {
  return Array.from({ length: n }, () => 100 / n);
}
