// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { REF_MAX, shortRef, shortSubject } from "../src/components/sidebar/refText.ts";

test("short subjects cut at a word boundary", () => {
  assert.equal(shortSubject("Fix it", 20), "Fix it");
  assert.equal(shortSubject("Git graph: color commits by sync state", 20), "Git graph: color…");
  assert.ok(shortSubject("Averyveryverylongwordwithoutspaces", 20).length <= 21);
});

test("ref labels keep their start and end", () => {
  assert.equal(shortRef("main"), "main");
  const s = shortRef("origin/feature/login-redirect-loop");
  assert.equal(s.length, REF_MAX);
  assert.ok(s.startsWith("origin/f") && s.endsWith("loop") && s.includes("…"));
});
