import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-events-"));
process.env.LOG_LEVEL = "error";
const { isEventName, productMetrics, pruneEvents, recordEvent } = await import("../src/lib/server/events.ts");

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 20, 12);

test("events: only known names; active visitors, retention and feature use by distinct visitors", () => {
  assert.equal(isEventName("click_ai"), true);
  assert.equal(isEventName("toString"), false, "not fooled by inherited keys");
  assert.equal(isEventName("drop table"), false);

  // a: first visit 10 days ago, back on day 1 and day 7; b: 10 days ago, never back; c: new today, uses AI twice
  const at = (d: number) => NOW - d * DAY;
  recordEvent("a".repeat(16), "first_visit", "/", at(10));
  recordEvent("a".repeat(16), "visit", "/", at(10));
  recordEvent("a".repeat(16), "visit", "/coin/BTC", at(9) + 3600_000);
  recordEvent("a".repeat(16), "visit", "/", at(3) + 3600_000);
  recordEvent("b".repeat(16), "first_visit", "/", at(10));
  recordEvent("c".repeat(16), "first_visit", "/", at(0.5));
  recordEvent("c".repeat(16), "click_ai", "/coin/ETH", at(0.4));
  recordEvent("c".repeat(16), "click_ai", "/coin/ETH", at(0.3));
  recordEvent("z".repeat(16), "visit", "/", at(500));

  const m = productMetrics(NOW);
  assert.equal(m.dau, 1);
  assert.equal(m.wau, 2);
  assert.equal(m.mau, 3);
  assert.deepEqual(
    m.retention.map((r) => [r.day, r.cohort, r.returned]),
    [
      [1, 2, 1],
      [7, 2, 1],
      [30, 0, 0],
    ],
  );
  assert.equal(m.weeks[0].active, 2);
  assert.equal(m.weeks[0].newVisitors, 1);
  assert.equal(m.weeks[0].features.click_ai, 1, "counted once per visitor");
  assert.equal(m.weeks[1].newVisitors, 2);

  assert.equal(pruneEvents(NOW), 1, "older than 400 days");
});
