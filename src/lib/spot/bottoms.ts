import { sma, SPOT_RULES, type Rulers, type SpotSeries } from "./valuation.ts";

/**
 * The 见底清单 on the 现货囤币 page: six "bottom" conditions bloggers often cite, which ones hold today,
 * and what happened after each past cycle first had half of them lit. Research E27 (project files e27/).
 * Pure; every value on day i uses only data up to day i.
 *
 * E27 (BTC, Coin Metrics daily, 2014–2026-10): weekly RSI first under 30 marked the bottom week in 2015
 * and 2018, but 2022 and 2026 fell a further 23% / 17%; at 32 instead of 30, 2014 fell a further 46%.
 * The six conditions mostly say one thing (price fell a lot) and light up together; the first time
 * each cycle had 3 of 6 lit, price still fell 6–46% further, and was higher one to two years later
 * every time, with only five cycles. So the page says "cheaper zone, buy in batches", never "bottom".
 */

export const BOTTOM_RULES = {
  /** weekly RSI length (Wilder) on weekly closes, every 7th day back */
  rsiLen: 14,
  rsiLow: 30,
  /** Pi Cycle Bottom: the 150-day EMA under 0.745 × the 471-day average */
  piEma: 150,
  piSma: 471,
  piMult: 0.745,
  /** price under the 50-week average */
  week50: 50,
  /** "half lit" */
  half: 3,
  /** deepest close looked for after an episode starts */
  drawdownDays: 730,
  horizons: [365, 730] as const,
} as const;

export type BottomKey = "rsi30" | "wma200" | "mvrv1" | "piBottom" | "ma200" | "week50";

export interface BottomItem {
  key: BottomKey;
  label: string;
  /** what the item measures, one phrase */
  kind: string;
  lit: boolean;
  /** the item's own value now, in words ("周线 RSI 58.0") */
  value: string;
  /** for price lines: the price where it would light, and its distance from today's close in % */
  price: number | null;
  distPct: number | null;
}

export interface BottomEpisode {
  start: string;
  price: number;
  /** labels lit on the first day */
  lit: BottomKey[];
  /** deepest close within 2 years after the start */
  low: number;
  lowDay: string;
  /** low / price − 1, % (0 when it never closed lower) */
  drawdownPct: number;
  /** price after 1 and 2 years / price (null: not that old yet) */
  after: { days: number; mult: number | null }[];
}

export interface BottomList {
  day: string;
  items: BottomItem[];
  litCount: number;
  /** first day the six can all be computed */
  from: string;
  episodes: BottomEpisode[];
  /** episodes old enough for each horizon, and how many of them were higher */
  higher: { days: number; n: number; up: number }[];
  /** the further fall after the start, over episodes that have had 2 years (or all, most recent included) */
  furtherDrop: { min: number; max: number; median: number; n: number } | null;
}

/** Wilder RSI of the weekly closes ending on each day (closes i, i−7, i−14, …); null until it has `len` changes. */
export function weeklyRsi(p: number[], len: number = BOTTOM_RULES.rsiLen): (number | null)[] {
  const out: (number | null)[] = new Array(p.length).fill(null);
  // seven interleaved weekly series, one per weekday
  for (let r = 0; r < 7 && r < p.length; r++) {
    let ag = 0,
      al = 0,
      k = 0;
    for (let i = r + 7; i < p.length; i += 7) {
      const ch = p[i] - p[i - 7];
      const g = Math.max(ch, 0),
        l = Math.max(-ch, 0);
      k++;
      if (k <= len) {
        ag += g / len;
        al += l / len;
        if (k < len) continue;
      } else {
        ag = (ag * (len - 1) + g) / len;
        al = (al * (len - 1) + l) / len;
      }
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  return out;
}

/** Exponential moving average seeded with the first value; null before `n` days. */
export function ema(p: number[], n: number): (number | null)[] {
  const k = 2 / (n + 1);
  let e = p[0];
  return p.map((x, i) => {
    e = i === 0 ? x : e + (x - e) * k;
    return i < n - 1 ? null : e;
  });
}

const LABELS: Record<BottomKey, { label: string; kind: string }> = {
  rsi30: { label: "周线 RSI 低于 30", kind: "动能" },
  wma200: { label: "跌破 200 周均线", kind: "长期均线" },
  mvrv1: { label: "MVRV 低于 1（跌破全网平均成本）", kind: "链上估值" },
  piBottom: { label: "Pi Cycle Bottom（150 日 EMA 低于 471 日均线 × 0.745）", kind: "均线" },
  ma200: { label: "跌破 200 日均线", kind: "中期均线" },
  week50: { label: "跌破 50 周均线", kind: "中期均线" },
};

export const BOTTOM_ORDER: BottomKey[] = ["rsi30", "wma200", "mvrv1", "piBottom", "ma200", "week50"];

const r1 = (x: number) => Math.round(x * 10) / 10;

export function bottomList(s: SpotSeries, r: Rulers): BottomList | null {
  const P = s.price;
  const L = P.length - 1;
  if (L < 0) return null;
  const R = BOTTOM_RULES;
  const rsi = weeklyRsi(P);
  const e150 = ema(P, R.piEma);
  const s471 = sma(P, R.piSma);
  const w50 = sma(P, R.week50, 7);
  const tests: Record<BottomKey, (i: number) => boolean | null> = {
    rsi30: (i) => (rsi[i] == null ? null : rsi[i]! < R.rsiLow),
    wma200: (i) => (r.wmaMult[i] == null ? null : r.wmaMult[i]! < SPOT_RULES.wmaLow),
    mvrv1: (i) => (r.mvrv[i] == null ? null : r.mvrv[i]! < SPOT_RULES.mvrvLow),
    piBottom: (i) => (e150[i] == null || s471[i] == null ? null : e150[i]! < s471[i]! * R.piMult),
    ma200: (i) => (r.ma200[i] == null ? null : P[i] < r.ma200[i]!),
    week50: (i) => (w50[i] == null ? null : P[i] < w50[i]!),
  };
  const dist = (lvl: number | null) => (lvl == null ? null : r1((lvl / P[L] - 1) * 100));
  const at = (k: BottomKey) => tests[k](L) === true;
  const items: BottomItem[] = BOTTOM_ORDER.map((key) => {
    const base = { key, ...LABELS[key], lit: at(key) };
    switch (key) {
      case "rsi30":
        return { ...base, value: rsi[L] == null ? "数据不够" : `周线 RSI ${rsi[L]!.toFixed(1)}`, price: null, distPct: null };
      case "wma200":
        return { ...base, value: "200 周均线", price: r.wma200[L], distPct: dist(r.wma200[L]) };
      case "mvrv1":
        return { ...base, value: r.mvrv[L] == null ? "数据不够" : `MVRV ${r.mvrv[L]!.toFixed(2)}，全网平均成本`, price: r.realized[L], distPct: dist(r.realized[L]) };
      case "piBottom": {
        const line = s471[L] == null ? null : s471[L]! * R.piMult;
        const gap = line == null || e150[L] == null ? null : r1((e150[L]! / line - 1) * 100);
        return { ...base, value: gap == null ? "数据不够" : `150 日 EMA 比线${gap >= 0 ? "高" : "低"} ${Math.abs(gap).toFixed(1)}%`, price: null, distPct: null };
      }
      case "ma200":
        return { ...base, value: "200 日均线", price: r.ma200[L], distPct: dist(r.ma200[L]) };
      case "week50":
        return { ...base, value: "50 周均线", price: w50[L], distPct: dist(w50[L]) };
    }
  });
  // history: days where all six can be computed
  let from = -1;
  for (let i = 0; i <= L; i++)
    if (BOTTOM_ORDER.every((k) => tests[k](i) != null)) {
      from = i;
      break;
    }
  const count = (i: number) => BOTTOM_ORDER.filter((k) => tests[k](i) === true).length;
  const episodes: BottomEpisode[] = [];
  if (from >= 0) {
    let lastHalf = -Infinity;
    for (let i = from; i <= L; i++) {
      if (count(i) < R.half) continue;
      if (i - lastHalf > SPOT_RULES.episodeGapDays) {
        let mi = i;
        for (let j = i; j <= Math.min(L, i + R.drawdownDays); j++) if (P[j] < P[mi]) mi = j;
        episodes.push({
          start: s.day[i],
          price: P[i],
          lit: BOTTOM_ORDER.filter((k) => tests[k](i) === true),
          low: P[mi],
          lowDay: s.day[mi],
          drawdownPct: r1((P[mi] / P[i] - 1) * 100),
          after: R.horizons.map((h) => ({ days: h, mult: i + h <= L ? P[i + h] / P[i] : null })),
        });
      }
      lastHalf = i;
    }
  }
  const higher = R.horizons.map((h, k) => {
    const done = episodes.map((e) => e.after[k].mult).filter((m): m is number => m != null);
    return { days: h, n: done.length, up: done.filter((m) => m > 1).length };
  });
  const drops = episodes.map((e) => e.drawdownPct).sort((a, b) => a - b);
  const furtherDrop = drops.length ? { min: drops[drops.length - 1], max: drops[0], median: drops[Math.floor((drops.length - 1) / 2)], n: drops.length } : null;
  return { day: s.day[L], items, litCount: items.filter((x) => x.lit).length, from: from < 0 ? "" : s.day[from], episodes, higher, furtherDrop };
}

/** What E27 found, for the page. */
export const BOTTOM_FACTS = {
  same: "这 6 项大多在说同一件事：价格已经跌了很多，所以常常一起亮。MVRV-Z 小于 0 和 MVRV 小于 1 是同一个条件，没有单列。",
  rsi: "周线 RSI 第一次跌破 30：2015、2018 年正好是见底那周；2022、2026 年之后又跌了 23%、17%。门槛换成 32，2014 年那次之后又跌了 46%，“30”是事后挑出来的。",
  divergence: "周线 RSI 底背离（价格创新低、RSI 没有）同一轮会出现好几次，事后才知道哪次是最后一次：2014-12 那次之后又跌了 45%，2022-09 那次之后又跌了 19%。",
  missing: "CVDD 要链上币天数据、爆仓量没有免费的历史，这里不列。",
} as const;
