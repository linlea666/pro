import { test } from "node:test";
import assert from "node:assert/strict";
import { againstBig, bigTrend, bigTrendLine, tfTrend, tfTrendText, type TfTrend } from "../src/lib/ta/bigtrend.ts";
import { atrSeries } from "../src/lib/ta/risk.ts";
import { structureDirection, structureSeries, swings } from "../src/lib/ta/structure.ts";
import type { Candle } from "../src/lib/types.ts";

const T = (dir: 1 | -1 | 0, over: Partial<TfTrend> = {}): TfTrend => ({ tf: "1d", dir, label: dir > 0 ? "上升趋势" : dir < 0 ? "下降趋势" : "区间 / 转折中", sinceT: 1_792_627_200, sincePrice: 84050, bars: 10, atLeast: false, protective: null, pierceAt: null, flipAt: null, ...over });

test("bigTrend: a direction only when the week and the day agree; against only then", () => {
  const down = bigTrend(T(-1, { tf: "1w" }), T(-1))!;
  assert.equal(down.dir, -1);
  assert.equal(againstBig(down, 1), true);
  assert.equal(againstBig(down, -1), false);
  const mixed = bigTrend(T(-1, { tf: "1w" }), T(0))!;
  assert.equal(mixed.dir, 0);
  assert.equal(againstBig(mixed, 1), false);
  assert.equal(againstBig(null, 1), false);
  assert.equal(bigTrend(null, T(1)), null);
  assert.match(bigTrendLine(down), /^周线、日线都向下/);
  assert.match(bigTrendLine(mixed), /^周线、日线方向不一致/);
});

test("tfTrendText: since when, and the close that ends it", () => {
  // 2026-10-22 00:00 UTC is 08:00 in Beijing
  const d = T(-1, { protective: 84875.2, flipAt: 86606 });
  assert.equal(tfTrendText(d), "日线下降趋势，10-22 收盘起第 10 天（当时 84,050）；日收盘站上 86,606 才算失效（保护高点 84,875）");
  assert.equal(tfTrendText(T(1, { tf: "1w", protective: 60000, flipAt: 55000 })), "周线上升趋势，2026-10-22 收盘起第 10 周；周收盘跌破 55,000 才算失效（保护低点 60,000）");
  assert.equal(tfTrendText(T(0)), "日线区间 / 转折中，10-22 收盘起第 10 天（当时 84,050）；等日线走出更高或更低的高低点");
  assert.match(tfTrendText(T(-1, { label: "区间 / 转折中" })), /^日线区间 \/ 转折中（向下脱离中）/);
  assert.match(tfTrendText(T(-1, { atLeast: true })), /，至少 10 天/);
});

test("tfTrend: the run of the current direction and the failure price beyond the protective swing", () => {
  // a down staircase: lower highs and lower lows, one bar per day
  const c: Candle[] = [];
  let p = 1000;
  for (let i = 0; i < 200; i++) {
    const leg = Math.floor(i / 10) % 2 === 0 ? -1 : 0.6;
    p += leg * 8;
    c.push({ t: i * 86400, o: p, h: p + 5, l: p - 5, c: p, v: 1 });
  }
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr);
  const x = tfTrend("1d", c, atr, ss, swings(c, atr))!;
  const n = c.length - 1;
  assert.equal(x.dir, structureDirection(ss[n]));
  assert.equal(x.dir, -1);
  assert.ok(x.bars >= 1 && x.bars <= c.length);
  assert.equal(x.sinceT, c[n - x.bars + 1].t + 86400);
  assert.ok(x.protective != null && x.flipAt! > x.protective && x.pierceAt! > x.protective && x.pierceAt! < x.flipAt!);
  assert.equal(tfTrend("1d", c.slice(0, 20), atr, ss, []), null);
});
