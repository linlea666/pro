import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { quietRanks, quietStats } from "../src/lib/ta/impulse.ts";
import { SQUEEZE_FACTS, SQUEEZE_RULES, squeezeAt, squeezeAtr, squeezeBrief, squeezeHeadline, squeezeLines } from "../src/lib/ta/squeeze.ts";
import { forbiddenPhrase } from "../src/lib/tdbrief.ts";

const T0 = 1_700_000_000 - (1_700_000_000 % 86400);

/** `days` days of hourly bars; the last `quietDays` days swing `small` instead of `big` */
function hours(days: number, quietDays: number, big = 0.01, small = 0.002): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < days * 24; i++) {
    const amp = i >= (days - quietDays) * 24 ? small : big;
    p *= i % 2 ? 1 + amp : 1 - amp;
    out.push({ t: T0 + i * 3600, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1 });
  }
  return out;
}

test("quietRanks is quietStats().rank", () => {
  const h = hours(380, 10);
  assert.deepEqual([...quietRanks(h)], [...quietStats(h).rank]);
});

test("squeezeAt: shows after a quiet week, only BTC / ETH, not when vol is normal", () => {
  const h = hours(380, 10);
  const s = quietStats(h);
  const last = h.at(-1)!.t;
  const x = squeezeAt("BTC", s, last)!;
  assert.ok(x);
  assert.ok(x.q <= SQUEEZE_RULES.maxQ);
  assert.ok(x.sdX != null && x.sdX < 0.5);
  assert.ok(squeezeAt("ETH", s, last));
  assert.equal(squeezeAt("SOL", s, last), null);
  const n = hours(380, 10, 0.002, 0.01);
  assert.equal(squeezeAt("BTC", quietStats(n), n.at(-1)!.t), null);
  // not enough history for a yearly rank
  const short = hours(200, 10);
  assert.equal(squeezeAt("BTC", quietStats(short), short.at(-1)!.t), null);
  assert.equal(SQUEEZE_RULES.maxQ, 0.1);
});

test("squeeze text: says it is not a breakout signal, no forbidden phrases", () => {
  const x = { coin: "BTC", day: T0, q: 0.03, sdX: 0.55 };
  assert.equal(squeezeHeadline(x), "之前 7 天的波动排在过去一年最低的 3%");
  assert.equal(squeezeHeadline({ ...x, q: 0.001 }), "之前 7 天的波动排在过去一年最低的 1%");
  assert.match(squeezeHeadline({ ...x, q: 0 }), /每一天都低/);
  assert.match(squeezeAtr(x), /0\.55 倍/);
  assert.equal(squeezeAtr({ ...x, sdX: null }), SQUEEZE_FACTS.atr);
  const all = [...Object.values(SQUEEZE_FACTS), squeezeBrief(x), ...squeezeLines(x)].join("\n");
  assert.match(SQUEEZE_FACTS.after, /不是变盘信号/);
  assert.match(SQUEEZE_FACTS.short, /不是变盘信号/);
  assert.equal(forbiddenPhrase(all), null);
  assert.doesNotMatch(all, /抄底|即将|要变盘|蓄势/);
});
