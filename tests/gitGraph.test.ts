// Run: npm test  (node --experimental-strip-types --test tests/*.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitWebUrl, remoteToWeb } from "../src/components/sidebar/gitWeb.ts";
import { computeGraph, laneX, segmentPath, type GraphGeometry } from "../src/components/sidebar/graphLayout.ts";

const SHA = "0ea6771a3b9c2d4e5f60718293a4b5c6d7e8f901";

test("remote URLs map to the hosting site", () => {
  const gh = "https://github.com/Tomkoooo/tCon";
  for (const r of [
    "git@github.com:Tomkoooo/tCon.git",
    "git@github.com:Tomkoooo/tCon",
    "ssh://git@github.com/Tomkoooo/tCon.git",
    "ssh://git@ssh.github.com:443/Tomkoooo/tCon.git",
    "https://github.com/Tomkoooo/tCon.git",
    "https://token@github.com/Tomkoooo/tCon/",
    "http://www.github.com/Tomkoooo/tCon",
    "git://github.com/Tomkoooo/tCon.git",
  ]) {
    assert.deepEqual(remoteToWeb(r), { host: "GitHub", base: gh }, r);
  }
  assert.equal(commitWebUrl("git@github.com:o/r.git", SHA), `https://github.com/o/r/commit/${SHA}`);
  assert.equal(commitWebUrl("git@gitlab.com:group/sub/r.git", SHA), `https://gitlab.com/group/sub/r/-/commit/${SHA}`);
  assert.equal(commitWebUrl("https://gitlab.example.org/a/b", SHA), `https://gitlab.example.org/a/b/-/commit/${SHA}`);
  assert.equal(commitWebUrl("git@bitbucket.org:team/r.git", SHA), `https://bitbucket.org/team/r/commits/${SHA}`);
});

test("unknown or malformed remotes give no URL", () => {
  for (const r of ["", null, undefined, "/srv/git/repo.git", "../other", "file:///tmp/r.git", "git@example.com:o/r.git", "https://github.com/onlyowner", "not a url"]) {
    assert.equal(remoteToWeb(r), null, String(r));
  }
  assert.equal(commitWebUrl("git@github.com:o/r.git", "HEAD~1"), null);
});

const G: GraphGeometry = { laneW: 10, rowH: 22, pad: 2 };

test("straight segments stay in their lane", () => {
  assert.equal(laneX(0, G), 7);
  assert.equal(laneX(2, G), 27);
  assert.equal(segmentPath({ x1: 1, y1: 0, x2: 1, y2: 1, color: 0 }, G), "M17 0V22");
});

test("lane changes are vertical-tangent cubic curves", () => {
  // fork: node centre in lane 0 → bottom edge of lane 2
  const d = segmentPath({ x1: 0, y1: 0.5, x2: 2, y2: 1, color: 0 }, G);
  assert.equal(d, "M7 11C7 16.5 27 16.5 27 22");
  const [, x1, y1, c1x, c1y, c2x, c2y, x2, y2] = /^M(\S+) (\S+)C(\S+) (\S+) (\S+) (\S+) (\S+) (\S+)$/.exec(d)!.map(Number);
  // control points keep the start and end x, so the curve leaves and arrives vertically
  assert.equal(c1x, x1);
  assert.equal(c2x, x2);
  assert.ok(c1y > y1 && c1y === c2y && c2y < y2);
});

test("graph layout: fork and merge", () => {
  const c = (id: string, parents: string[]) => ({ id, shortId: id, summary: id, author: "", time: 0, parents, refs: [] });
  // m merges b into a; both come from root r
  const rows = computeGraph([c("m", ["a", "b"]), c("b", ["r"]), c("a", ["r"]), c("r", [])]);
  assert.equal(rows[0].isMerge, true);
  assert.equal(rows[0].lane, 0);
  assert.equal(rows[1].lane, 1); // b gets its own lane
  assert.equal(rows[2].lane, 0);
  assert.equal(rows[3].lane, 0); // both lanes converge on r
  assert.ok(rows[3].segments.some((s) => s.x1 === 1 && s.x2 === 0));
  assert.notEqual(rows[1].color, rows[0].color);
});
