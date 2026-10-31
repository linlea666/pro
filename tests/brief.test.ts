import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { atrSeries } from "../src/lib/ta/risk.ts";
import { structureSeries } from "../src/lib/ta/structure.ts";
import { phaseAt } from "../src/lib/ta/phase.ts";
import { briefText, marketBrief, phaseTone, type BriefLevelIn, type MarketBrief } from "../src/lib/ta/brief.ts";
import type { BigTrend, TfTrend } from "../src/lib/ta/bigtrend.ts";
import { forbiddenPhrase } from "../src/lib/tdbrief.ts";

const T0 = Date.parse("2026-03-02T00:00:00Z") / 1000;

/** 4-hour bars walking through the given prices in steps of 0.5 (a small wick on each side). */
function path(points: number[]): Candle[] {
  const out: Candle[] = [];
  let p = points[0];
  for (const to of points.slice(1)) {
    while (Math.abs(to - p) > 1e-9) {
      const o = p;
      p = Math.abs(to - p) <= 0.5 ? to : p + Math.sign(to - p) * 0.5;
      out.push({ t: T0 + out.length * 14400, o, h: Math.max(o, p) + 0.1, l: Math.min(o, p) - 0.1, c: p, v: 1 });
    }
  }
  return out;
}

// the same walk as the phase tests: a decline, a stall, a bounce, a higher low, a reclaim, a new uptrend
const c = path([100, 112, 106, 110, 103, 107, 98, 98, 98.5, 98, 98.5, 98, 101, 99.5, 102.5, 100.5, 104, 101.5, 106]);
const atr = atrSeries(c);
const ss = structureSeries(c, atr, 2);

const day = (over: Partial<TfTrend> = {}): TfTrend => ({ tf: "1d", dir: -1, label: "下降趋势", sinceT: T0, sincePrice: 110, bars: 10, atLeast: false, protective: 111, pierceAt: 111.2, flipAt: 112.5, close: 100, phase: "下跌中", ...over });
const big: BigTrend = { day: day(), week: day({ tf: "1w", phase: "反弹", flipAt: 130, protective: 125 }), dir: -1 };
const lv = (price: number): BriefLevelIn => ({ price, methods: ["摆动高低", "前日/周/月高低"], methodCount: 3, tfs: ["日线", "4小时"] });

function briefAt(n: number, withBig = true): MarketBrief | null {
  const cc = c.slice(0, n + 1);
  const price = cc[n].c;
  const levels = [90, 95, 96.5, 97, 104, 108, 109].map(lv);
  return marketBrief({
    price,
    h4: { c: cc, atr: atr.slice(0, n + 1), ss: ss.slice(0, n + 1) },
    h1: { c: cc, atr: atr.slice(0, n + 1), ss: ss.slice(0, n + 1) },
    big: withBig ? big : null,
    supports: levels.filter((l) => l.price <= price).sort((a, b) => b.price - a.price),
    resistances: levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price),
  });
}

const allText = (b: MarketBrief) => [b.title, b.line, ...b.numbers.flatMap((v) => [v.label, v.note]), ...b.cells.map((x) => x.text), ...b.next.flatMap((r) => [r.when, r.then, r.fact ?? ""]), b.against ?? "", b.foot].join("\n");
const prices = (s: string) => [...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, "")));

test("too few bars: no brief", () => {
  assert.equal(briefAt(20), null);
});

test("every bar after warm-up: numbers high to low, the conditions use the card's own numbers, no forecasts", () => {
  let seen = new Set<number>();
  for (let n = 60; n < c.length; n++) {
    const b = briefAt(n);
    const p = phaseAt(c, atr, ss, n);
    if (!p) continue;
    assert.ok(b, `bar ${n}`);
    seen.add(p.stage);
    for (let k = 1; k < b.numbers.length; k++) assert.ok(b.numbers[k - 1].price >= b.numbers[k].price, "numbers sorted high to low");
    assert.equal(new Set(b.numbers.map((v) => v.key)).size, b.numbers.length, "each kind once");
    // the prices in the "what next" rows are the numbers above (as printed), so the two never disagree
    const shown = new Set(b.numbers.map((v) => Number(briefText({ ...b, numbers: [v] })[2].split(" ").pop()!.replace(/,/g, ""))));
    for (const r of b.next) for (const x of prices(r.when)) if (x !== 4) assert.ok(shown.has(x), `bar ${n}: ${r.when} uses ${x}, not on the card (${[...shown].join(" / ")})`);
    assert.equal(forbiddenPhrase(allText(b)), null, `bar ${n}`);
    assert.doesNotMatch(allText(b), /分界|先看|会去|偏多|偏空|看多|看空/);
    if (b.band) assert.ok(b.band.lo < b.band.hi);
    assert.equal(b.cells.map((x) => x.tf).join(","), "1h,4h,1d,1w");
    assert.match(b.against!, /做多是逆日线，按规则半仓/);
  }
  assert.ok(seen.has(1) && seen.has(2) && seen.has(3) && seen.has(4), `stages seen: ${[...seen].join(",")}`);
});

test("stall (②): the low, the turn line, the daily line; band from the low to the bounce high", () => {
  const n = [...Array(c.length).keys()].find((k) => k > 60 && ss[k].state === "down" && phaseAt(c, atr, ss, k)?.stage === 2)!;
  const b = briefAt(n)!;
  const p = phaseAt(c, atr, ss, n)!;
  const core = b.numbers.find((v) => v.key === "core")!;
  assert.equal(core.price, p.invalid);
  assert.equal(core.label, "这段低点");
  assert.equal(b.numbers.find((v) => v.key === "turn")!.price, p.trigger);
  assert.equal(b.numbers.find((v) => v.key === "flip")!.price, 112.5);
  assert.match(b.title, /^日线下降趋势，4 小时止跌尝试$/);
  assert.match(b.line, /没再创新低，但低点还没站住/);
  assert.equal(b.next[0].when, `4 小时跌破 ${core.price}`);
  assert.match(b.next[0].fact!, /先回到下跌中/);
  assert.match(b.next[1].then, /还要再走出更高的低点/);
  assert.equal(b.next[2].when, "日线收盘站上 112.5");
  // without the weekly / daily frames the card still works, without the daily line and cells
  const lone = briefAt(n, false)!;
  assert.equal(lone.numbers.some((v) => v.key === "flip"), false);
  assert.equal(lone.cells.length, 2);
  assert.equal(lone.against, null);
  assert.match(lone.title, /^4 小时止跌尝试$/);
});

test("turned (④): the higher low is what to hold, and the nearest level ahead replaces the turn line", () => {
  const n = [...Array(c.length).keys()].find((k) => k > 60 && phaseAt(c, atr, ss, k)?.dir === 1 && phaseAt(c, atr, ss, k)?.stage === 4)!;
  const b = briefAt(n)!;
  const p = phaseAt(c, atr, ss, n)!;
  assert.equal(b.numbers.find((v) => v.key === "core")!.label, "更高的低点");
  assert.equal(b.numbers.find((v) => v.key === "core")!.price, p.higherLow);
  assert.equal(b.numbers.some((v) => v.key === "turn"), false);
  assert.match(b.line, /^4 小时已转强；跌破 .+（更高的低点）就算转强失败。$/);
  assert.match(b.next[0].then, /^转强失败，回到下跌中/);
  assert.equal(b.band, null);
});

test("phaseTone: down / up by what the cell says, the middle ones neutral", () => {
  assert.equal(phaseTone("下跌中"), "down");
  assert.equal(phaseTone("转弱"), "down");
  assert.equal(phaseTone("上涨中"), "up");
  assert.equal(phaseTone("转强"), "up");
  assert.equal(phaseTone("反弹"), "neutral");
  assert.equal(phaseTone(null), "neutral");
});
