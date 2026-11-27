// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileUrlToPath, pathsForTerminal, quotePath } from "../src/terminal/quotePath.ts";

test("paths are escaped like macOS Terminal does", () => {
  assert.equal(quotePath("/Users/me/shot.png"), "/Users/me/shot.png");
  assert.equal(quotePath("/Users/me/Screen Shot (1).png"), "/Users/me/Screen\\ Shot\\ \\(1\\).png");
  assert.equal(quotePath("/tmp/it's"), "/tmp/it\\'s");
  assert.equal(pathsForTerminal(["/a b", "/c"]), "/a\\ b /c ");
  assert.equal(pathsForTerminal([]), "");
});

test("file URLs decode to paths", () => {
  assert.equal(fileUrlToPath("file:///Users/me/My%20File.png"), "/Users/me/My File.png");
  assert.equal(fileUrlToPath("https://x"), null);
});
