// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinMatches, pinVisibleIn, readPins, type PinnedApp } from "../src/browser/pinModel.ts";

const pin = (url: string, extra: Partial<PinnedApp> = {}): PinnedApp => ({ id: "p", name: "x", url, icon: "database", color: "", ...extra });

test("readPins keeps valid pins and repairs or drops broken entries", () => {
  assert.deepEqual(readPins(undefined), []);
  assert.deepEqual(readPins({ url: "http://x" }), []);
  const pins = readPins([
    { id: "a", name: " Compass ", url: "http://localhost:8081", icon: "database", color: "#4fc6c6", project: "/Users/me/app/" },
    { url: "https://adminer.local/", icon: "rocket", color: "red" },
    { url: "file:///etc/passwd" },
    { url: "javascript:alert(1)" },
    null,
    "http://string-entry",
  ]);
  assert.equal(pins.length, 2);
  assert.deepEqual(pins[0], { id: "a", name: "Compass", url: "http://localhost:8081", icon: "database", color: "#4fc6c6", favicon: null, project: "/Users/me/app" });
  assert.equal(pins[1].id, "https://adminer.local/");
  assert.equal(pins[1].icon, "globe");
  assert.equal(pins[1].color, "");
  assert.equal(pins[1].project, null);
});

test("pins match pages of the same origin under the pinned path", () => {
  const compass = pin("http://localhost:8081/");
  assert.ok(pinMatches(compass, "http://localhost:8081/"));
  assert.ok(pinMatches(compass, "http://localhost:8081/explorer/db/users"));
  assert.ok(!pinMatches(compass, "http://localhost:3000/"));
  assert.ok(!pinMatches(compass, "https://localhost:8081/"));
  const adminer = pin("https://tools.example.com/adminer/?pgsql=db");
  assert.ok(pinMatches(adminer, "https://tools.example.com/adminer/?pgsql=db&table=users"));
  assert.ok(!pinMatches(adminer, "https://tools.example.com/grafana/"));
  assert.ok(!pinMatches(adminer, "not a url"));
});

test("project-limited pins only show in their project", () => {
  assert.ok(pinVisibleIn(pin("http://a"), "/any"));
  const own = pin("http://a", { project: "/Users/me/app" });
  assert.ok(pinVisibleIn(own, "/Users/me/app/"));
  assert.ok(!pinVisibleIn(own, "/Users/me/other"));
});
