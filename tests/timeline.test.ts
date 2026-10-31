import { test } from "node:test";
import assert from "node:assert/strict";
import { bigTrendOf, bigTrendText, changesOf, firstHit, parseBj, parseStep, relation } from "../src/lib/timeline.ts";
import type { Candle } from "../src/lib/types.ts";

const row = (tf: string, direction: 1 | -1 | 0, label: string) => ({ tf, direction, view: { label } }) as never;

test("bigTrendOf: a direction only when the week and the day agree", () => {
  assert.deepEqual(bigTrendOf({ map: [row("1w", -1, "下降趋势"), row("1d", -1, "下降趋势"), row("4h", 1, "上升趋势")] }), { dir: -1, week: "下降趋势", day: "下降趋势" });
  assert.equal(bigTrendOf({ map: [row("1w", -1, "下降趋势"), row("1d", 0, "区间 / 转折中")] })!.dir, 0);
  assert.equal(bigTrendOf({ map: [row("1w", 0, "区间"), row("1d", 0, "区间")] })!.dir, 0);
  assert.equal(bigTrendOf({ map: [row("1d", 1, "上升趋势")] }), null);
  assert.equal(bigTrendText({ dir: -1, week: "下降趋势", day: "下降趋势" }), "下降（周线下降趋势，日线下降趋势）");
});

test("relation: with, against, neutral", () => {
  const down = { dir: -1 as const, week: "", day: "" };
  assert.equal(relation(1, down), "逆");
  assert.equal(relation(-1, down), "顺");
  assert.equal(relation(1, { ...down, dir: 0 }), "中性");
  assert.equal(relation(1, null), "中性");
});

const bar = (t: number, h: number, l: number): Candle => ({ t, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1 });

test("firstHit: stop first, target first, a bar touching both counts as the stop, nothing yet", () => {
  // long at 100, stop 95 (risk 5), target 110
  const c = [bar(0, 101, 99), bar(1, 104, 98), bar(2, 111, 100)];
  assert.deepEqual(firstHit(c, 1, 1, 100, 95), { result: "target", t: 2, mfe: 2.2 });
  assert.deepEqual(firstHit([bar(1, 103, 94)], 1, 1, 100, 95), { result: "stop", t: 1, mfe: 0 });
  assert.deepEqual(firstHit([bar(1, 112, 94)], 1, 1, 100, 95).result, "stop");
  assert.deepEqual(firstHit([bar(1, 104, 97)], 1, 1, 100, 95), { result: "open", t: null, mfe: 0.8 });
  // short at 100, stop 105, target 90; bars before `from` are skipped
  assert.deepEqual(firstHit([bar(0, 120, 80), bar(1, 101, 89)], 1, -1, 100, 105), { result: "target", t: 1, mfe: 2.2 });
});

test("changesOf: every change after the first value, skipping missing values", () => {
  const rows = [{ t: 1, p: 10, v: "a" }, { t: 2, p: 11, v: "a" }, { t: 3, p: 12, v: null }, { t: 4, p: 13, v: "b" }, { t: 5, p: 14, v: "a" }];
  assert.deepEqual(changesOf(rows, (r) => r.v, (r) => r.t, (r) => r.p), [{ t: 4, price: 13, from: "a", to: "b" }, { t: 5, price: 14, from: "b", to: "a" }]);
});

test("parseBj / parseStep: Beijing time unless a zone is given", () => {
  assert.equal(parseBj("2026-09-15"), Date.parse("2026-09-14T16:00:00Z") / 1000);
  assert.equal(parseBj("2026-09-15 20:00"), Date.parse("2026-09-15T12:00:00Z") / 1000);
  assert.equal(parseBj("2026-09-15T00:00:00Z"), Date.parse("2026-09-15T00:00:00Z") / 1000);
  assert.throws(() => parseBj("昨天"));
  assert.equal(parseStep(undefined), 14400);
  assert.equal(parseStep("1h"), 3600);
  assert.throws(() => parseStep("2h"));
});
