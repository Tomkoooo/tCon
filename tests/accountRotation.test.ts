// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { earliestReset, isLimited, nextAccount, pruneLimits, NO_RESET_COOLDOWN, type AccountLimit } from "../src/accountRotation.ts";

const NOW = 1_800_000_000_000;
const order = ["a", "b", "c"];
const all = () => true;
const lim = (resetIn: number | null, ago = 0): AccountLimit => ({ limitedAt: NOW - ago, resetAt: resetIn === null ? null : NOW + resetIn, message: "limit" });

test("picks the next account in order, wrapping around", () => {
  assert.equal(nextAccount(order, "a", all, {}, NOW), "b");
  assert.equal(nextAccount(order, "c", all, {}, NOW), "a");
});

test("skips limited and unusable accounts", () => {
  assert.equal(nextAccount(order, "a", all, { b: lim(60_000) }, NOW), "c");
  assert.equal(nextAccount(order, "a", (id) => id !== "b", {}, NOW), "c");
});

test("stops instead of looping when it comes back around", () => {
  assert.equal(nextAccount(order, "a", all, { a: lim(1), b: lim(60_000), c: lim(null) }, NOW), null);
  assert.equal(nextAccount(["a"], "a", all, {}, NOW), null);
});

test("a lifted limit makes the account usable again", () => {
  assert.equal(nextAccount(order, "a", all, { b: lim(-1) }, NOW), "b");
  assert.equal(nextAccount(order, "a", all, { b: lim(null, NO_RESET_COOLDOWN + 1) }, NOW), "b");
  assert.ok(isLimited(lim(null, 1000), NOW));
});

test("earliest reset among limited accounts", () => {
  const limits = { a: lim(90_000), b: lim(30_000), c: lim(null) };
  assert.deepEqual(earliestReset(order, all, limits, NOW), { id: "b", at: NOW + 30_000 });
  assert.deepEqual(earliestReset(order, (id) => id !== "b", limits, NOW), { id: "a", at: NOW + 90_000 });
  assert.equal(earliestReset(order, all, {}, NOW), null);
});

test("pruneLimits drops lifted limits", () => {
  assert.deepEqual(Object.keys(pruneLimits({ a: lim(-1), b: lim(5) }, NOW)), ["b"]);
});

test("weekly and 5-hour usage are told apart", async () => {
  const { limitWindow, usageText } = await import("../src/accountRotation.ts");
  assert.equal(limitWindow("You've used 90% of your weekly limit"), "weekly");
  assert.equal(limitWindow("5-hour limit reached ∙ resets 3pm"), "session");
  const u = (percent: number) => ({ percent, resetAt: null, at: NOW, message: "" });
  assert.equal(usageText(undefined, { session: u(85), weekly: u(40) }, NOW)?.short, "5h 85% · Week 40%");
  assert.match(usageText({ ...lim(86_400_000), window: "weekly" }, undefined, NOW)!.short, /^Weekly limit · resets/);
});
