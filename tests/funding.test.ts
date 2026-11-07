import { test } from "node:test";
import assert from "node:assert/strict";
import { FUNDING_FACT, fundingCost, fundingHeadline, fundingLines, fundingView } from "../src/lib/ta/funding.ts";
import { forbiddenPhrase } from "../src/lib/tdbrief.ts";

const H = 8 * 3600;
const at = 1_800_000_000;
const hist = (rates: number[]) => rates.map((rate, i) => ({ t: at - (rates.length - i) * H, rate }));

test("who pays whom and how much", () => {
  const base = { intervalH: 8, live: true, nextAt: null, history: [], at };
  assert.equal(fundingView({ ...base, rate: 0.0001 }).side, "longs");
  assert.equal(fundingView({ ...base, rate: 0.0001 }).level, "normal");
  assert.equal(fundingView({ ...base, rate: -0.00002 }).side, "flat");
  assert.equal(fundingView({ ...base, rate: -0.00008 }).level, "slight");
  assert.equal(fundingView({ ...base, rate: -0.0002 }).level, "clear");
  assert.equal(fundingView({ ...base, rate: 0.0005 }).level, "high");
  // a 4-hour interval doubles the per-8-hour rate
  assert.equal(fundingView({ ...base, rate: 0.0001, intervalH: 4 }).level, "clear");
  assert.match(fundingHeadline(fundingView({ ...base, rate: -0.0002 })), /空头付给多头/);
});

test("cost per day: longs pay when positive, shorts the reverse", () => {
  const v = fundingView({ rate: 0.0001, intervalH: 8, live: true, nextAt: null, history: [], at });
  assert.equal(Math.round(v.longPerDay * 100) / 100, 3);
  assert.match(fundingCost(v, 1), /多单每 10,000 U 每天约付 3\.0 U/);
  assert.match(fundingCost(v, -1), /空单每 10,000 U 每天约收 3\.0 U/);
});

test("crowding by 90-day rank, streak and 7-day mean use settled history only", () => {
  const rates = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.0001 : 0.00005));
  const hi = fundingView({ rate: 0.0004, intervalH: 8, live: true, nextAt: null, history: hist(rates), at });
  assert.equal(hi.crowd, "longs");
  const lo = fundingView({ rate: -0.0001, intervalH: 8, live: true, nextAt: null, history: hist(rates), at });
  assert.equal(lo.crowd, "shorts");
  const mid = fundingView({ rate: 0.0001, intervalH: 8, live: true, nextAt: null, history: hist(rates), at });
  assert.equal(mid.crowd, null);
  // the exchange default is not crowding even when most settlements sit below it
  const def = fundingView({ rate: 0.0001, intervalH: 8, live: true, nextAt: null, history: hist(Array(200).fill(0.00004)), at });
  assert.equal(def.pct! > 80 && def.crowd === null, true);
  // nor is a rate that is barely negative
  const tiny = fundingView({ rate: -0.00001, intervalH: 8, live: true, nextAt: null, history: hist(Array(200).fill(0.00004)), at });
  assert.equal(tiny.crowd, null);
  // 90 days of 8-hour settlements = 270; only those inside the window count
  assert.equal(Math.round(hi.avg7d! * 1e6), 75);
  const neg = fundingView({ rate: -0.0001, intervalH: 8, live: true, nextAt: null, history: hist([0.0001, -0.00001, -0.00002, -0.00003]), at });
  assert.deepEqual(neg.streak, { sign: -1, n: 3 });
  assert.equal(neg.pct, null); // too few settlements
  // future settlements are ignored
  const fut = fundingView({ rate: 0, intervalH: 8, live: false, nextAt: null, history: [{ t: at + H, rate: 0.01 }], at });
  assert.equal(fut.avg7d, null);
});

test("no forecasting words", () => {
  const v = fundingView({ rate: -0.0004, intervalH: 8, live: true, nextAt: at + H, history: hist(Array(100).fill(0.0001)), at });
  for (const s of [...fundingLines(v, () => "16:00"), FUNDING_FACT]) assert.equal(forbiddenPhrase(s), null, s);
});
