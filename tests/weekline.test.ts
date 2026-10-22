import { test } from "node:test";
import assert from "node:assert/strict";
import { weekLine, weekLineText } from "../src/lib/ta/weekline.ts";
import { weeklyCloses } from "../src/lib/spot/valuation.ts";

test("weekLine: null under the length, then side, run length and distance", () => {
  assert.equal(weekLine([1, 2, 3], 4), null);
  // 4-week average; the last two closes are above it, the one before below
  const c = [10, 10, 10, 10, 6, 14, 15];
  const w = weekLine(c, 4)!;
  assert.equal(w.sma, (10 + 6 + 14 + 15) / 4);
  assert.equal(w.above, true);
  assert.equal(w.weeks, 2);
  assert.equal(w.weeksAtLeast, false);
  assert.equal(w.distPct, Math.round((15 / 11.25 - 1) * 1000) / 10);
  assert.equal(weekLineText(w), "站上 4 周均线第 2 周（收盘比它高 33.3%）");
});

test("weekLine: a run that reaches the start of the history is a lower bound", () => {
  const w = weekLine([5, 4, 3, 2, 1], 3)!;
  assert.equal(w.above, false);
  assert.equal(w.weeks, 3);
  assert.equal(w.weeksAtLeast, true);
  assert.match(weekLineText(w), /^跌破 3 周均线至少 3 周（收盘比它低/);
});

test("weeklyCloses: every 7th close back from the latest, oldest first", () => {
  const p = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(weeklyCloses(p), [5, 12, 19]);
});
