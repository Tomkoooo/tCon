// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { insertIndex } from "../src/components/workbench/tabDrag.ts";

// Apply a move the way the workspace store does: remove the item, then insert at the index.
function move<T>(list: T[], from: number, to: number): T[] {
  const out = list.filter((_, i) => i !== from);
  out.splice(to, 0, list[from]);
  return out;
}

test("dropping before/after a tab in the same list", () => {
  const tabs = ["a", "b", "c", "d"];
  assert.deepEqual(move(tabs, 0, insertIndex(0, 2, false)), ["b", "a", "c", "d"]);
  assert.deepEqual(move(tabs, 0, insertIndex(0, 2, true)), ["b", "c", "a", "d"]);
  assert.deepEqual(move(tabs, 3, insertIndex(3, 0, false)), ["d", "a", "b", "c"]);
  assert.deepEqual(move(tabs, 3, insertIndex(3, 1, true)), ["a", "b", "d", "c"]);
  assert.deepEqual(move(tabs, 1, insertIndex(1, 3, true)), ["a", "c", "d", "b"]);
  // Dropping onto a neighbour's near edge leaves the order as it was.
  assert.deepEqual(move(tabs, 1, insertIndex(1, 2, false)), tabs);
  assert.deepEqual(move(tabs, 1, insertIndex(1, 0, true)), tabs);
});

test("dropping a tab from another list", () => {
  assert.equal(insertIndex(-1, 0, false), 0);
  assert.equal(insertIndex(-1, 0, true), 1);
  assert.equal(insertIndex(-1, 2, true), 3);
});
