import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import {
  FLUSH_FACTS,
  FLUSH_RULES,
  FLUSH_RULE_TEXT,
  flushAt,
  flushBase,
  flushFact,
  flushHeadline,
  flushLines,
  flushState,
  oiChangeRank,
  settledFunding,
  sweptLow,
  type FlushState,
} from "../src/lib/ta/flush.ts";
import { forbiddenPhrase } from "../src/lib/tdbrief.ts";

const H = 3600;
const T0 = 1_700_000_000 - (1_700_000_000 % H);

/** n flat hour bars around 100 (low 99), then the given lows */
function hours(n: number, lows: number[] = []): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push({ t: T0 + i * H, o: 100, h: 101, l: 99, c: 100, v: 1 });
  lows.forEach((l, k) => out.push({ t: T0 + (n + k) * H, o: 100, h: 101, l, c: 100, v: 1 }));
  return out;
}

/** a year and a half of hourly open interest, gently wiggling; `last` overrides the final hours */
function oiSeries(endT: number, last: [number, number][] = []) {
  const t: number[] = [], oi: number[] = [];
  for (let T = endT - 500 * 86400; T <= endT; T += H) {
    t.push(T);
    oi.push(1000 * (1 + 0.05 * Math.sin(T / (H * 17))));
  }
  for (const [T, v] of last) oi[t.indexOf(T)] = v;
  return { t, oi };
}

test("sweptLow: the low of the 7 days before, only when this bar breaks it", () => {
  const h = hours(FLUSH_RULES.win, [98.5]);
  assert.equal(sweptLow(h, FLUSH_RULES.win), 99);
  assert.equal(sweptLow(hours(FLUSH_RULES.win, [99]), FLUSH_RULES.win), null);
  assert.equal(sweptLow(h, FLUSH_RULES.win - 1), null);
});

test("settledFunding: the last settlement at or before the moment", () => {
  const f = { t: [100, 200, 300], rate: [0.0001, -0.0002, 0.0003] };
  assert.equal(settledFunding(f, 99), null);
  assert.equal(settledFunding(f, 200), -0.0002);
  assert.equal(settledFunding(f, 299), -0.0002);
  assert.equal(settledFunding(f, 1000), 0.0003);
});

test("oiChangeRank: 24-hour change and where it falls in the year before", () => {
  const end = T0 + 600 * 86400;
  const base = oiSeries(end);
  const r = oiChangeRank(base, end)!;
  assert.ok(r.pct > 0 && r.pct < 1);
  // a 30% drop over the last 24 hours is the lowest of the year
  const drop = oiSeries(end, [[end, base.oi[base.t.indexOf(end - 24 * H)] * 0.7]]);
  const d = oiChangeRank(drop, end)!;
  assert.ok(d.chg < -0.29);
  assert.equal(d.pct, 0);
  // no value exactly 24 hours before: unknown
  assert.equal(oiChangeRank({ t: [end], oi: [1] }, end), null);
  // too short a history: unknown
  const short = { t: base.t.filter((x) => x > end - 20 * 86400), oi: base.oi.slice(-(20 * 24)) };
  assert.equal(oiChangeRank(short, end), null);
});

test("flushState: E43's groups", () => {
  assert.equal(flushState(-0.0001, 0.05), "golden");
  assert.equal(flushState(-0.0001, 0.6), "neg");
  assert.equal(flushState(0.0001, 0.05), "flush");
  assert.equal(flushState(0.0001, 0.6), "kept");
  assert.equal(flushState(0.0001, 0.3), "mid");
  assert.equal(flushState(0, 0.6), "mid");
});

test("flushAt: only BTC / ETH, only within 24 hours of the sweep, null when data is missing", () => {
  const n = 400;
  const h = hours(n, [98, 99.5, 99.5]);
  const end = h[h.length - 1].t + H;
  const oi = oiSeries(end);
  const funding = { t: [end - 10 * H, end - H], rate: [0.0001, 0.00004] };
  const x = flushAt("BTC", h, funding, oi)!;
  assert.ok(x);
  assert.equal(x.t, T0 + n * H);
  assert.equal(x.low, 98);
  assert.equal(x.prevLow, 99);
  // the settlement known at the sweep's close, not the later one
  assert.equal(x.rate, 0.0001);
  assert.equal(x.now.rate, 0.00004);
  assert.equal(flushAt("SOL", h, funding, oi), null);
  assert.equal(flushAt("BTC", h, null, oi), null);
  assert.equal(flushAt("BTC", h, funding, null), null);
  // 24 closed hours after the sweep it is gone
  const later = hours(n, [98, ...Array(FLUSH_RULES.showHours).fill(99.5)]);
  assert.equal(flushAt("BTC", later, funding, oiSeries(later[later.length - 1].t + H)), null);
  // no sweep at all
  assert.equal(flushAt("BTC", hours(n + 3), funding, oi), null);
});

test("flushAt: the newest sweep wins, and a lower low after it is reported", () => {
  const h = hours(400, [98, 99.5, 97.5, 99]);
  const end = h[h.length - 1].t + H;
  const x = flushAt("ETH", h, { t: [end - 20 * H], rate: [-0.0001] }, oiSeries(end))!;
  assert.equal(x.low, 97.5);
  assert.equal(x.prevLow, 98);
  assert.ok(x.state === "neg" || x.state === "golden");
});

test("texts: every state has its numbers, nothing predictive", () => {
  const h = hours(400, [98]);
  const end = h[h.length - 1].t + H;
  const base = flushAt("BTC", h, { t: [end - H], rate: [0.0001] }, oiSeries(end))!;
  for (const coin of ["BTC", "ETH"])
    for (const state of ["golden", "neg", "flush", "kept", "mid"] as FlushState[]) {
      const x = { ...base, coin, state, lower: 97 };
      const lines = [flushHeadline(x), flushFact(x), flushBase(x), ...flushLines(x), FLUSH_RULE_TEXT];
      for (const l of lines) assert.equal(forbiddenPhrase(l), null, l);
      assert.match(flushBase(x), new RegExp(`${FLUSH_FACTS[coin].all.brk30}%`));
      if (state === "kept") assert.match(flushFact(x), new RegExp(`${FLUSH_FACTS[coin].kept.brk30}%.*其他状态 ${FLUSH_FACTS[coin].kept.other}%`));
      if (state === "neg") assert.match(flushFact(x), new RegExp(`费率不负 ${FLUSH_FACTS[coin].neg.other}%`));
    }
  assert.match(flushHeadline(base), /扫过 7 天低点 99 之后/);
});
