import { test } from "node:test";
import assert from "node:assert/strict";
import { after, atLeast, bandOf, bucketTable, changes, leverageTable, liqPct, pctRank, quantile, sortedAbs, swingAfter, topMoves, worstSpan } from "../src/lib/ta/moves.ts";
import type { Candle } from "../src/lib/types.ts";
import * as MV from "../src/lib/ta/moves.ts";

const D = 86400;
/** Daily bars from closes; open = previous close, high / low 1% around the bar unless given. */
function days(closes: number[], wick: { h?: number[]; l?: number[] } = {}): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: i * D, o, h: wick.h?.[i] ?? Math.max(o, c) * 1.01, l: wick.l?.[i] ?? Math.min(o, c) * 0.99, c, v: 1 };
  });
}

test("changes skips gaps in the series", () => {
  const c = days([100, 110, 99, 99]);
  c[3].t += D; // a missing day before the last bar
  const m = changes(c, 1, D);
  assert.equal(m.length, 2);
  assert.ok(Math.abs(m[0].pct - 10) < 1e-9);
  assert.ok(Math.abs(m[1].pct + 10) < 1e-9);
});

test("percentile rank, quantile and bands", () => {
  const s = [1, 2, 3, 4];
  assert.equal(pctRank(s, 3), 50);
  assert.equal(pctRank(s, 10), 100);
  assert.equal(pctRank([], 1), null);
  assert.equal(quantile(s, 0.5), 2.5);
  assert.equal(bandOf(49.9), "平常");
  assert.equal(bandOf(80), "大");
  assert.equal(bandOf(99), "极端");
  assert.equal(bandOf(null), null);
});

test("bucket table counts each side by size, with how often and the latest day", () => {
  const m = [
    { t: 0, pct: -0.5 },
    { t: D, pct: -2.5 },
    { t: 2 * D, pct: 2.5 },
    { t: 3 * D, pct: -12 },
    { t: 4 * D, pct: 0 },
    { t: 5 * D, pct: -2.9 },
  ];
  const rows = bucketTable(m, D);
  const b23 = rows.find((r) => r.lo === 2)!;
  assert.equal(b23.down.n, 2);
  assert.equal(b23.down.last, 5 * D);
  assert.equal(b23.down.everySec, 3 * D); // 6 days / 2
  assert.equal(b23.up.n, 1);
  const top = rows[rows.length - 1];
  assert.equal(top.hi, null);
  assert.equal(top.down.n, 1);
  // a zero move counts on neither side
  assert.equal(rows.reduce((s, r) => s + r.down.n + r.up.n, 0), 5);
  // at least as big, same direction
  assert.equal(atLeast(m, -2.5, D).n, 3);
  assert.equal(atLeast(m, 2, D).n, 1);
});

test("top moves keep one per crash", () => {
  const m = [
    { t: 0, pct: -10 },
    { t: D, pct: -9 },
    { t: 10 * D, pct: -5 },
    { t: 20 * D, pct: 3 },
  ];
  assert.deepEqual(
    topMoves(m, 5, -1, 3 * D).map((x) => x.pct),
    [-10, -5],
  );
  assert.deepEqual(
    topMoves(m, 5, 1, 3 * D).map((x) => x.pct),
    [3],
  );
});

test("after gives the change from that close, null past the end", () => {
  const c = days([100, 90, 99, 108]);
  const a = after(c, D, [1, 2, 5]);
  assert.ok(Math.abs(a[0]! - 10) < 1e-9);
  assert.ok(Math.abs(a[1]! - 20) < 1e-9);
  assert.equal(a[2], null);
});

test("leverage table: liquidation by the wick from the day's open, within the day and over the hold", () => {
  assert.ok(Math.abs(liqPct(10) - 9.5) < 1e-9);
  // day 1 opens at 100 and wicks to 89 (−11%): a 10x long dies that day; day 2 opens at 95, wicks 1%
  const c: Candle[] = [
    { t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 },
    { t: D, o: 100, h: 101, l: 89, c: 95, v: 1 },
    { t: 2 * D, o: 95, h: 96, l: 94, c: 95, v: 1 },
  ];
  const [r] = leverageTable(c, [10], 2);
  assert.equal(r.day.long.share, 33.33);
  assert.equal(r.day.long.last, D);
  assert.equal(r.day.short.share, 0);
  assert.equal(r.day.short.everySec, null);
  // two-day holds start on day 0 and day 1, both reach 89
  assert.equal(r.week.long.share, 100);
});

test("worst span and the swing after the biggest moves", () => {
  const c = days([100, 100, 50, 60, 60]);
  const w = worstSpan(c, 2)!;
  assert.equal(w.pct, -50);
  assert.equal(w.from, 0);
  // 300 quiet days of about ±0.5–0.8% with one −10% day followed by three ±3% days
  const m = Array.from({ length: 300 }, (_, i) => ({ t: i * D, pct: (i % 2 ? 1 : -1) * (0.5 + i / 1000) }));
  m[100].pct = -10;
  for (const k of [101, 102, 103]) m[k].pct = 3;
  const s = swingAfter(m, -1, 0.005)!;
  assert.equal(s.n, 1);
  const avg = m.reduce((a, x) => a + Math.abs(x.pct), 0) / m.length;
  assert.ok(Math.abs(s.ratio - Math.round((3 / avg) * 100) / 100) < 1e-9);
  assert.equal(swingAfter(m.slice(0, 50), -1), null);
  assert.deepEqual(sortedAbs([{ t: 0, pct: -3 }, { t: 1, pct: 2 }]), [2, 3]);
});

test("price ladder: prices from the reference, shares of days, and the share given the move so far", () => {
  const { excursions, priceLadder } = MV;
  // four days after the first: lows 2%, 4%, 6% and 1% under the previous close of 100
  const c: Candle[] = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 1 }, ...[98, 96, 94, 99].map((l, i) => ({ t: (i + 1) * D, o: 100, h: 101, l, c: 100, v: 1 }))];
  const ex = excursions(c);
  assert.equal(ex.length, 4);
  const { rows, givenN } = priceLadder(ex, 200, 3, -1, [2, 5]);
  assert.equal(rows[0].price, 196);
  assert.equal(rows[0].share, 75);
  assert.equal(rows[0].reached, true);
  assert.equal(rows[0].given, null);
  assert.equal(rows[1].share, 25);
  // two days fell at least 3%; one of them reached 5%
  assert.equal(givenN, 2);
  assert.equal(rows[1].given, 50);
});

test("rebounds compare big days with every day, one case per week", () => {
  const { rebounds } = MV;
  // flat at 100 except a −10% day (low 85) on day 10, then closes 95, 100, 102 … 102
  const closes = Array.from({ length: 30 }, (_, i) => (i === 10 ? 90 : i === 11 ? 95 : i >= 12 ? 102 : 100));
  const c = days(closes, { l: closes.map((x, i) => (i === 10 ? 85 : x * 0.99)) });
  const rows = rebounds(c, -1, [5], [3, 7]);
  assert.equal(rows.length, 2);
  const big = rows[0];
  assert.equal(big.n, 1);
  assert.ok(Math.abs(big.bounce! - ((102 * 1.01) / 85 - 1) * 100) < 1e-9); // highest high in 3 days from the low
  assert.deepEqual(big.back, [100, 100]);
  assert.equal(rows[1].min, null);
  assert.ok(rows[1].n > 20);
});

test("realised volatility and streaks", () => {
  const { realizedVol, streaks } = MV;
  const flat = days(Array.from({ length: 40 }, () => 100));
  assert.equal(realizedVol(flat)[0].pct, 0);
  assert.equal(realizedVol(flat).length, 10);
  const s = streaks(days([100, 99, 98, 97, 98, 99, 98]));
  assert.equal(s.longestDown!.n, 3);
  assert.ok(Math.abs(s.longestDown!.pct + 3) < 1e-9);
  assert.equal(s.longestUp!.n, 2);
  assert.equal(s.current!.dir, -1);
  assert.equal(s.current!.n, 1);
});
