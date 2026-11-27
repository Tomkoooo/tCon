// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyFilter, fuzzyMatch } from "../src/search/fuzzy.ts";

test("characters must appear in order", () => {
  assert.ok(fuzzyMatch("bv", "src/components/tasks/BoardView.tsx"));
  assert.equal(fuzzyMatch("vb", "BoardView.tsx"), null);
  assert.deepEqual(fuzzyMatch("", "x"), { score: 0, positions: [] });
});

test("file-name and word-start matches rank first", () => {
  const files = ["src/components/tasks/BoardView.tsx", "src/store/workspace.ts", "src/components/sidebar/GitPanel.tsx", "src/board/view.ts"];
  const r = fuzzyFilter(files, "boardview", (f) => f).map((x) => x.item);
  assert.equal(r[0], "src/components/tasks/BoardView.tsx");
  const r2 = fuzzyFilter(files, "gitp", (f) => f).map((x) => x.item);
  assert.equal(r2[0], "src/components/sidebar/GitPanel.tsx");
  assert.equal(fuzzyFilter(files, "zzz", (f) => f).length, 0);
});
