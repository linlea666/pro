import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { allow, resetLimits } from "../src/lib/server/ratelimit.ts";
import { forwardStats, labelStats, wilson } from "../src/lib/ta/stats.ts";
import { DEFAULT_BUFFER_ATR, atrSeries, bufferAtr, noiseProb, structureAnchors, type Calibration } from "../src/lib/ta/risk.ts";

/** Small deterministic PRNG so the random-walk tests never flake. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function randomWalk(n: number, seed: number): Candle[] {
  const r = rng(seed);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= 1 + (r() - 0.5) * 0.02;
    return { t: i * 3600, o, h: Math.max(o, p) * (1 + r() * 0.003), l: Math.min(o, p) * (1 - r() * 0.003), c: p, v: 100 };
  });
}

test("rate limit: fixed window per bucket and IP", () => {
  resetLimits();
  const t = 1_000_000;
  for (let k = 0; k < 3; k++) assert.equal(allow("x", "1.1.1.1", 3, 60_000, t).ok, true);
  const no = allow("x", "1.1.1.1", 3, 60_000, t + 10);
  assert.equal(no.ok, false);
  assert.ok(no.retryAfter > 0 && no.retryAfter <= 60);
  assert.equal(allow("x", "2.2.2.2", 3, 60_000, t).ok, true, "other IPs are not affected");
  assert.equal(allow("y", "1.1.1.1", 3, 60_000, t).ok, true, "other buckets are not affected");
  assert.equal(allow("x", "1.1.1.1", 3, 60_000, t + 60_001).ok, true, "a new window starts fresh");
});

test("forwardStats: overlapping signals count once and the cost is deducted", () => {
  const up = Array.from({ length: 100 }, (_, i): Candle => ({ t: i * 3600, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 }));
  assert.equal(forwardStats(up, "k", "k", "bull", [10, 11, 12, 13, 20], 5).samples, 2);
  const flat = Array.from({ length: 100 }, (_, i): Candle => ({ t: i * 3600, o: 100, h: 100, l: 100, c: 100, v: 1 }));
  const s = forwardStats(flat, "k", "k", "bull", Array.from({ length: 15 }, (_, k) => k * 6), 5);
  assert.equal(s.winRate, 0, "a flat market loses the cost");
  assert.ok((s.avgReturn ?? 0) < 0);
});

test("wilson interval contains the point estimate and narrows with samples", () => {
  const [a, b] = wilson(6, 10);
  assert.ok(a < 60 && b > 60);
  const [c, d] = wilson(600, 1000);
  assert.ok(d - c < b - a);
});

test("labelStats: random signals on random walks are rarely called strong or adverse", () => {
  let pagesWithClaims = 0;
  const pages = 40;
  for (let p = 0; p < pages; p++) {
    const c = randomWalk(2000, 1000 + p);
    const r = rng(p + 7);
    const list = Array.from({ length: 24 }, (_, k) => {
      const idx = Array.from({ length: 2000 }, (_, i) => i).filter(() => r() < 0.05);
      return forwardStats(c, `s${k}`, `s${k}`, k % 2 ? "bull" : "bear", idx, 6);
    });
    labelStats(list);
    if (list.some((s) => s.reliability === "证据较强" || s.reliability === "历史上不利")) pagesWithClaims++;
  }
  assert.ok(pagesWithClaims / pages <= 0.1, `${pagesWithClaims}/${pages} random pages made a claim`);
});

test("labelStats: a genuinely good signal still gets through", () => {
  const c = randomWalk(2000, 42);
  // indices right before rises of more than 1% over the next 6 bars: a perfect (look-ahead) signal
  const idx = c.map((_, i) => i).filter((i) => i + 6 < c.length && c[i + 6].c > c[i].c * 1.01);
  const good = forwardStats(c, "g", "g", "bull", idx, 6);
  const noise = Array.from({ length: 20 }, (_, k) => forwardStats(c, `n${k}`, `n${k}`, "bull", c.map((_, i) => i).filter((i) => i % (17 + k) === 0), 6));
  labelStats([good, ...noise]);
  assert.equal(good.reliability, "证据较强");
});

test("risk: buffer and noise curve interpolate, defaults without calibration", () => {
  assert.equal(bufferAtr(null, 80), DEFAULT_BUFFER_ATR);
  assert.equal(noiseProb(null, 1), null);
  const cal: Calibration = { probe: { "75": 0.6, "80": 0.8, "85": 1.0 }, noise: [[1, 60], [2, 30], [4, 10]], horizon: 6, samples: 100 };
  assert.equal(bufferAtr(cal, 80), 0.8);
  assert.ok(Math.abs(bufferAtr(cal, 82) - 0.88) < 1e-9);
  assert.equal(noiseProb(cal, 0.5), 80);
  assert.equal(noiseProb(cal, 1.5), 45);
  assert.equal(noiseProb(cal, 10), 10);
});

test("risk: structural anchors are intact swing lows below price, nearest first", () => {
  // down to 90, bounce to 110, dip to 100, rally to 120
  const path = [...Array.from({ length: 20 }, (_, i) => 110 - i), ...Array.from({ length: 20 }, (_, i) => 90 + i), ...Array.from({ length: 10 }, (_, i) => 110 - i), ...Array.from({ length: 20 }, (_, i) => 100 + i)];
  const c = path.map((p, i): Candle => ({ t: i * 3600, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 1 }));
  const a = structureAnchors(c, "1h", "below", 0.3, atrSeries(c));
  assert.ok(a.length >= 2);
  assert.ok(a[0].price > a[1].price, "nearest first");
  assert.ok(a.every((x) => x.price < c[c.length - 1].c));
  assert.equal(a[0].price, 99.5);
});

test("rate limit: IPv6 addresses in one /64 share a window; windows expire on their own length", async () => {
  const { ipKey } = await import("../src/lib/server/ratelimit.ts");
  assert.equal(ipKey("2001:db8:1:2:aaaa::1"), ipKey("2001:db8:1:2:bbbb::2"));
  assert.notEqual(ipKey("2001:db8:1:3::1"), ipKey("2001:db8:1:2::1"));
  assert.equal(ipKey("1.2.3.4"), "1.2.3.4");
  resetLimits();
  const t = 5_000_000;
  assert.equal(allow("hourly", "9.9.9.9", 1, 3600_000, t).ok, true);
  assert.equal(allow("hourly", "9.9.9.9", 1, 3600_000, t + 120_000).ok, false, "a 1-hour window is still closed after 2 minutes");
});

test("closedThrough: bars count as closed only up to the fetch time; stored data never closes its last bar", async () => {
  const { closedThrough } = await import("../src/lib/data/klines.ts");
  const candles: Candle[] = [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: 3600, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  assert.equal(closedThrough({ candles, source: "binance", fetchedAt: 7_100_000 }, 9_000_000), 7100);
  assert.equal(closedThrough({ candles, source: "local", fetchedAt: 9_000_000 }, 9_000_000), 3600);
});
