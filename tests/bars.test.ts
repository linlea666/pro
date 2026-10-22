import { test } from "node:test";
import assert from "node:assert/strict";

import { barStart, closedBetween, nextClose } from "../src/lib/bars.ts";

const utc = (s: string) => Date.parse(`${s}Z`) / 1000;

test("bar boundaries follow the exchange clock (UTC; weeks open on Monday)", () => {
  assert.equal(barStart("4h", utc("2026-10-22T14:07:00")), utc("2026-10-22T12:00:00"));
  assert.equal(nextClose("15m", utc("2026-10-22T14:07:00")), utc("2026-10-22T14:15:00"));
  assert.equal(nextClose("1d", utc("2026-10-22T14:07:00")), utc("2026-10-23T00:00:00"));
  // 2026-10-22 is a Thursday: the week opened on Monday 10-19
  assert.equal(barStart("1w", utc("2026-10-22T14:07:00")), utc("2026-10-19T00:00:00"));
  assert.equal(nextClose("1w", utc("2026-10-25T23:59:59")), utc("2026-10-26T00:00:00"));
  assert.equal(barStart("1w", utc("2026-10-26T00:00:00")), utc("2026-10-26T00:00:00"));
});

test("closedBetween: a cache from before a close is stale right after it", () => {
  const ms = (s: string) => utc(s) * 1000;
  assert.equal(closedBetween("5m", ms("2026-10-22T14:04:50"), ms("2026-10-22T14:05:02")), true);
  assert.equal(closedBetween("5m", ms("2026-10-22T14:05:01"), ms("2026-10-22T14:09:59")), false);
  assert.equal(closedBetween("1d", ms("2026-10-22T23:58:00"), ms("2026-10-23T00:00:03")), true);
});
