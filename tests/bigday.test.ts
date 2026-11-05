import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { BIGDAY_FACTS, BIGDAY_RULES, bigDayAt, bigDayFact, bigDayHeadline, bigDayLine, bigDayToday, dayShape, type BigDay, type DayPos } from "../src/lib/ta/bigday.ts";
import { briefText, type MarketBrief } from "../src/lib/ta/brief.ts";
import { forbiddenPhrase } from "../src/lib/tdbrief.ts";

const D0 = 1_760_000_000 - (1_760_000_000 % 86400);

/** 20 calm days (range 2 around 100), then one day with the given range and close position */
function days(range = 6, pos = 0.9): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 20; i++) out.push({ t: D0 + i * 86400, o: 100, h: 101, l: 99, c: 100, v: 1 });
  const l = 100 - range / 2, h = 100 + range / 2;
  out.push({ t: D0 + 20 * 86400, o: 100, h, l, c: l + pos * range, v: 1 });
  return out;
}
const today = D0 + 21 * 86400;
/** closed hour bars of today, each [low, high] */
const hours = (xs: [number, number][]): Candle[] => xs.map(([l, h], k) => ({ t: today + k * 3600, o: (l + h) / 2, h, l, c: (l + h) / 2, v: 1 }));

test("dayShape: ratio to the median of the 20 days before, and where it closed", () => {
  const d = days(6, 0.9);
  const s = dayShape(d, 20)!;
  assert.equal(Math.round(s.ratio * 10) / 10, 3);
  assert.equal(s.pos, "top");
  assert.equal(dayShape(days(6, 0.5), 20)!.pos, "mid");
  assert.equal(dayShape(days(6, 0.1), 20)!.pos, "bottom");
  assert.equal(dayShape(d, 19), null);
});

test("bigDayAt: only BTC / ETH, only at ≥ 2×, only when yesterday is the last closed day", () => {
  const d = days(6, 0.9);
  const h = hours([[101, 102]]);
  assert.ok(bigDayAt("BTC", d, h, today + 3600));
  assert.ok(bigDayAt("ETH", d, h, today + 3600));
  assert.equal(bigDayAt("SOL", d, h, today + 3600), null);
  assert.equal(bigDayAt("BTC", days(BIGDAY_RULES.ratio * 2 - 0.2, 0.9), h, today + 3600), null);
  // two days later: yesterday's bar is not the last closed one
  assert.equal(bigDayAt("BTC", d, h, today + 86400 + 3600), null);
});

test("bigDayAt: today so far, and the Asian session once it is over", () => {
  const d = days(6, 0.9); // high 103, low 97
  const early = bigDayAt("BTC", d, hours([[100, 102]]), today + 3600)!;
  assert.equal(early.aboveHigh, false);
  assert.equal(early.asiaDone, false);
  assert.match(bigDayToday(early)!, /还在前一天的高低点之间/);

  const h8 = hours(Array.from({ length: 9 }, () => [100, 102] as [number, number]));
  const afterAsia = bigDayAt("BTC", d, h8, today + 9 * 3600)!;
  assert.equal(afterAsia.asiaDone, true);
  assert.equal(afterAsia.asiaAbove, false);
  assert.match(bigDayToday(afterAsia)!, new RegExp(`亚洲时段.*没有越过前高.*${BIGDAY_FACTS.BTC.pos.top.asia!.later}%`));

  const broke = bigDayAt("BTC", d, hours([[100, 104]]), today + 3600)!;
  assert.equal(broke.aboveHigh, true);
  assert.match(bigDayToday(broke)!, /已越过前高 103/);
  // a bar that is still forming is not counted
  assert.equal(bigDayAt("BTC", d, hours([[100, 102], [100, 104]]), today + 3600)!.aboveHigh, false);

  const both = bigDayAt("BTC", d, hours([[96, 104]]), today + 3600)!;
  assert.match(bigDayToday(both)!, /已经不是 inside day/);
});

test("facts: every position has its sentence, the numbers on it, and nothing predictive", () => {
  for (const coin of Object.keys(BIGDAY_FACTS))
    for (const pos of ["top", "mid", "bottom"] as DayPos[]) {
      const p = BIGDAY_FACTS[coin].pos[pos];
      const x: BigDay = { coin, t: D0, high: 103, low: 97, close: 102, rangePct: 6, ratio: 3, pos, aboveHigh: false, belowLow: false, asiaDone: true, asiaAbove: false, asiaBelow: false };
      const f = bigDayFact(x);
      assert.ok(f.includes(`${p.n} 天`) && f.includes(`${p.inside}%`) && f.includes(`${p.upH}%`) && f.includes(`${p.dnL}%`), f);
      for (const s of [bigDayHeadline(x), f, bigDayToday(x) ?? "", bigDayLine(x)]) assert.equal(forbiddenPhrase(s), null, s);
      assert.match(bigDayLine(x), /只描述，不是信号/);
    }
});

test("briefText prints the line when the brief carries one", () => {
  const x = bigDayAt("BTC", days(6, 0.9), hours([[100, 102]]), today + 3600)!;
  const b = { title: "t", line: "l", numbers: [], band: null, cells: [], next: [], against: null, impulse: null, bigDay: x, foot: "", t: 0 } as MarketBrief;
  assert.ok(briefText(b).some((l) => l.includes("昨天是大波动日")));
});
