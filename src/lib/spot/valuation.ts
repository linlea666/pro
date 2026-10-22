import { weekLine, type WeekLine } from "../ta/weekline.ts";

/**
 * Long-horizon valuation rulers for BTC spot (the 现货囤币 page), ported from research E23a.
 * Pure: no database, no network; runs on the server, in the CLI and in the browser.
 *
 * Every value on day i uses only data up to day i (no lookahead): moving averages look back,
 * percentiles rank today against the days before it.
 *
 * The series must be contiguous days (index = day offset), because the 200-week average takes
 * every 7th day back. Coin Metrics has no gaps; `spotSeries` in data/spot.ts carries the previous
 * day forward if one is ever missing.
 */

export interface SpotSeries {
  /** YYYY-MM-DD, UTC, contiguous */
  day: string[];
  price: number[];
  /** coins in circulation */
  supply: (number | null)[];
  /** market cap / realized cap (Coin Metrics CapMVRVCur) */
  mvrv: (number | null)[];
  /** crypto Fear & Greed index of that day (alternative.me, from 2018-02) */
  fng: (number | null)[];
}

/** Thresholds and lengths; the page text quotes these. */
export const SPOT_RULES = {
  /** 200-day moving average (Mayer multiple = price / it) */
  mayerLen: 200,
  /** 200-week moving average of weekly closes (every 7th day back from today) */
  wmaWeeks: 200,
  /** a percentile needs at least this many earlier days */
  pctMinHistory: 730,
  /** percentile zones */
  pctLow: 0.2,
  pctHigh: 0.8,
  /** MVRV below 1: price under the average cost of all coins (realized price) */
  mvrvLow: 1,
  /** MVRV high zone is by percentile (≥ 80%) */
  mvrvHighPct: 0.8,
  /** price under the 200-week average */
  wmaLow: 1,
  mayerLow: 0.8,
  mayerHigh: 2.4,
  /** alternative.me bands: 0–25 extreme fear … 76–100 extreme greed */
  fngFear: 25,
  fngGreed: 76,
  /** the same zone more than this many days later is a new episode */
  episodeGapDays: 90,
  /** forward horizons for the episode table */
  horizons: [365, 730, 1460] as const,
  /** baseline: every day this many days before and after an episode's start */
  baselineDays: 730,
  /** "deepest close" looks this far after an episode's start */
  drawdownDays: 730,
} as const;

/** alternative.me's own bands, in Chinese */
export const FNG_BANDS: { max: number; label: string }[] = [
  { max: 25, label: "极度恐惧" },
  { max: 46, label: "恐惧" },
  { max: 54, label: "中性" },
  { max: 75, label: "贪婪" },
  { max: 100, label: "极度贪婪" },
];

export const fngLabel = (v: number | null | undefined) => (v == null ? null : (FNG_BANDS.find((b) => v <= b.max) ?? FNG_BANDS[FNG_BANDS.length - 1]).label);

export type ZoneLabel = "历史低位" | "中间" | "历史高位";
export const pctZone = (p: number | null | undefined): ZoneLabel | null =>
  p == null ? null : p <= SPOT_RULES.pctLow ? "历史低位" : p >= SPOT_RULES.pctHigh ? "历史高位" : "中间";

const DAY_MS = 86400_000;
export const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
export const dayStr = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * Expanding percentile: the share of earlier (non-null) values that are ≤ today's, once there are
 * at least `minHist` of them. Nulls stay null and are not counted. O(n log n) with a Fenwick tree
 * over the ranks of all values; the counts are exact, so this equals the plain O(n²) loop.
 */
export function expandingPercentile(v: (number | null)[], minHist: number = SPOT_RULES.pctMinHistory): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  const sorted = [...new Set(v.filter((x): x is number => x != null))].sort((a, b) => a - b);
  const tree = new Int32Array(sorted.length + 1);
  // 1-based rank of x among the distinct values
  const rank = (x: number) => {
    let lo = 0,
      hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  let seen = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x == null) continue;
    const r = rank(x);
    if (seen >= minHist) {
      let k = 0;
      for (let j = r; j > 0; j -= j & -j) k += tree[j];
      out[i] = k / seen;
    }
    for (let j = r; j <= sorted.length; j += j & -j) tree[j]++;
    seen++;
  }
  return out;
}

/** Simple moving average of `n` values taken every `step` days back from day i (null until there are enough). */
export function sma(p: number[], n: number, step = 1): (number | null)[] {
  return p.map((_, i) => {
    if (i < (n - 1) * step) return null;
    let s = 0;
    for (let k = 0; k < n; k++) s += p[i - k * step];
    return s / n;
  });
}

export interface Rulers {
  mvrv: (number | null)[];
  /** price / MVRV: the average cost of all coins */
  realized: (number | null)[];
  ma200: (number | null)[];
  mayer: (number | null)[];
  wma200: (number | null)[];
  wmaMult: (number | null)[];
  marketCap: (number | null)[];
  fng: (number | null)[];
  pct: { mvrv: (number | null)[]; wmaMult: (number | null)[]; mayer: (number | null)[]; fng: (number | null)[] };
}

export function rulers(s: SpotSeries): Rulers {
  const P = s.price;
  const ma200 = sma(P, SPOT_RULES.mayerLen);
  const wma200 = sma(P, SPOT_RULES.wmaWeeks, 7);
  const mvrv = s.mvrv.map((m) => (m != null && m > 0 ? m : null));
  const mayer = P.map((p, i) => (ma200[i] ? p / ma200[i]! : null));
  const wmaMult = P.map((p, i) => (wma200[i] ? p / wma200[i]! : null));
  return {
    mvrv,
    realized: P.map((p, i) => (mvrv[i] ? p / mvrv[i]! : null)),
    ma200,
    mayer,
    wma200,
    wmaMult,
    marketCap: P.map((p, i) => (s.supply[i] != null ? p * s.supply[i]! : null)),
    fng: s.fng,
    pct: { mvrv: expandingPercentile(mvrv), wmaMult: expandingPercentile(wmaMult), mayer: expandingPercentile(mayer), fng: expandingPercentile(s.fng) },
  };
}

/** Whether the "reserve" bucket of the accumulation plan fires that day: price below the 200-week average, or MVRV < 1. */
export function reserveSignal(r: Rulers, opts: { wma?: boolean; mvrv?: boolean } = {}): boolean[] {
  const { wma = true, mvrv = true } = opts;
  return r.mvrv.map((m, i) => (mvrv && m != null && m < SPOT_RULES.mvrvLow) || (wma && r.wmaMult[i] != null && r.wmaMult[i]! < SPOT_RULES.wmaLow));
}

// ---------------------------------------------------------------- now

/** Every 7th close back from the latest, oldest first: the same weeks the 200-week average uses. */
export function weeklyCloses(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length - 1; i >= 0; i -= 7) out.push(p[i]);
  return out.reverse();
}

export interface RulerNow {
  value: number | null;
  /** expanding percentile, 0–1 */
  pct: number | null;
  zone: ZoneLabel | null;
}

export type LowLineKey = "mvrv1" | "wma" | "mayer08";

export interface LowLine {
  key: LowLineKey;
  label: string;
  /** the price at which this ruler would be in its low zone today */
  price: number | null;
  /** (price / current − 1) in %, negative = below today's price */
  distPct: number | null;
  inZone: boolean;
  /** last day the zone held (today when inZone) */
  lastDay: string | null;
  /** first day of the latest episode */
  lastStart: string | null;
  daysSince: number | null;
}

export interface SpotNow {
  day: string;
  price: number;
  supply: number | null;
  marketCap: number | null;
  mvrv: RulerNow & { realizedPrice: number | null };
  /** value = price / 200-week average */
  wma: RulerNow & { wma200: number | null };
  /** value = price / 200-day average */
  mayer: RulerNow & { ma200: number | null };
  fng: RulerNow & { label: string | null };
  lowLines: LowLine[];
  /** highest daily close of the last 365 days */
  high52w: { price: number; day: string; distPct: number };
  /** whether the plan's reserve bucket would fire today */
  reserve: boolean;
  /** the 50-week average of weekly closes (every 7th day back from today), described only (E24) */
  week50: WeekLine | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const distPct = (level: number | null, price: number) => (level == null ? null : r1((level / price - 1) * 100));

function ruler(value: number | null, pct: number | null): RulerNow {
  return { value, pct, zone: pctZone(pct) };
}

export function spotNow(s: SpotSeries, r: Rulers = rulers(s)): SpotNow {
  const L = s.day.length - 1;
  const P = s.price[L];
  const zoneDays = (f: (i: number) => boolean) => {
    let last = -1;
    for (let i = L; i >= 0; i--)
      if (f(i)) {
        last = i;
        break;
      }
    if (last < 0) return { lastDay: null, lastStart: null, daysSince: null };
    // walk back while the gaps stay within the episode rule
    let start = last;
    for (let i = last - 1; i >= 0 && start - i <= SPOT_RULES.episodeGapDays; i--) if (f(i)) start = i;
    return { lastDay: s.day[last], lastStart: s.day[start], daysSince: L - last };
  };
  const line = (key: LowLineKey, label: string, price: number | null, f: (i: number) => boolean): LowLine => ({
    key,
    label,
    price,
    distPct: distPct(price, P),
    inZone: f(L),
    ...zoneDays(f),
  });
  let hi = L;
  for (let i = Math.max(0, L - 364); i <= L; i++) if (s.price[i] > s.price[hi]) hi = i;
  return {
    day: s.day[L],
    price: P,
    supply: s.supply[L],
    marketCap: r.marketCap[L],
    mvrv: { ...ruler(r.mvrv[L], r.pct.mvrv[L]), realizedPrice: r.realized[L] },
    wma: { ...ruler(r.wmaMult[L], r.pct.wmaMult[L]), wma200: r.wma200[L] },
    mayer: { ...ruler(r.mayer[L], r.pct.mayer[L]), ma200: r.ma200[L] },
    fng: { ...ruler(r.fng[L], r.pct.fng[L]), label: fngLabel(r.fng[L]) },
    lowLines: [
      line("mvrv1", "MVRV 跌破 1（跌破全网平均成本）", r.realized[L], (i) => r.mvrv[i] != null && r.mvrv[i]! < SPOT_RULES.mvrvLow),
      line("wma", "跌破 200 周均线", r.wma200[L], (i) => r.wmaMult[i] != null && r.wmaMult[i]! < SPOT_RULES.wmaLow),
      line("mayer08", "Mayer 倍数低于 0.8", r.ma200[L] == null ? null : r.ma200[L]! * SPOT_RULES.mayerLow, (i) => r.mayer[i] != null && r.mayer[i]! < SPOT_RULES.mayerLow),
    ],
    high52w: { price: s.price[hi], day: s.day[hi], distPct: r1((P / s.price[hi] - 1) * 100) },
    reserve: reserveSignal(r)[L],
    week50: weekLine(weeklyCloses(s.price)),
  };
}

// ---------------------------------------------------------------- market-cap zones

export interface CapZone {
  label: string;
  /** market cap, USD */
  from: number;
  to: number;
}
export interface CapZonePrice extends CapZone {
  priceFrom: number;
  priceTo: number;
}

/** Market-cap levels to prices at today's supply. */
export function capZonePrices(supply: number, zones: CapZone[]): CapZonePrice[] {
  return zones.map((z) => ({ ...z, priceFrom: z.from / supply, priceTo: z.to / supply }));
}

// ---------------------------------------------------------------- episodes (E23a)

export type EpisodeZoneKey = "mvrv1" | "wma" | "mvrvHigh" | "fear";

export interface EpisodeZone {
  key: EpisodeZoneKey;
  name: string;
  low: boolean;
}

export const EPISODE_ZONES: EpisodeZone[] = [
  { key: "mvrv1", name: "MVRV < 1", low: true },
  { key: "wma", name: "低于 200 周均线", low: true },
  { key: "mvrvHigh", name: "MVRV 分位 ≥ 80%", low: false },
  { key: "fear", name: "极度恐惧（≤ 25）", low: true },
];

export interface EpisodeHorizon {
  days: number;
  /** geometric mean multiple over the episode's days that have data that far ahead (null: not yet) */
  mult: number | null;
  /** the same for every day within 2 years either side of the start (where the ruler exists) */
  base: number | null;
}

export interface EpisodeRow {
  start: string;
  end: string;
  /** days in the zone */
  days: number;
  entry: number;
  /** deepest close within 2 years after the start, and when */
  low: number;
  lowDay: string;
  /** low / entry − 1, % */
  drawdownPct: number;
  /** first close back at the entry price after that low; days counted from the start (as in E23a) */
  recoverDay: string | null;
  recoverDays: number | null;
  horizons: EpisodeHorizon[];
}

export interface EpisodeSummary {
  days: number;
  /** episodes with data that far ahead */
  n: number;
  /** of them, how many beat their same-era baseline */
  better: number;
  /** geometric mean of episode multiple / baseline multiple */
  ratio: number | null;
  consistent: boolean;
  verdict: string;
}

export interface EpisodeResult {
  zone: EpisodeZone;
  /** first day the ruler exists */
  from: string;
  totalDays: number;
  rows: EpisodeRow[];
  summary: EpisodeSummary[];
}

function zoneTest(key: EpisodeZoneKey, r: Rulers): { f: (i: number) => boolean; from: number } {
  const first = (v: (number | null)[]) => v.findIndex((x) => x != null);
  switch (key) {
    case "mvrv1":
      return { f: (i) => (r.mvrv[i] ?? 9) < SPOT_RULES.mvrvLow, from: first(r.mvrv) };
    case "wma":
      return { f: (i) => (r.wmaMult[i] ?? 9) < SPOT_RULES.wmaLow, from: first(r.wmaMult) };
    case "mvrvHigh":
      return { f: (i) => (r.pct.mvrv[i] ?? 0) >= SPOT_RULES.mvrvHighPct, from: Math.max(first(r.mvrv), first(r.pct.mvrv)) };
    case "fear":
      return { f: (i) => (r.fng[i] ?? 99) <= SPOT_RULES.fngFear, from: first(r.fng) };
  }
}

/** The honesty rule: under 30 independent samples nothing is called an edge; only say whether every episode agreed. */
export function episodeVerdict(n: number, consistent: boolean) {
  return `样本不足（只有 ${n} 段），${consistent ? "各段方向一致" : "各段方向不一"}`;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

/**
 * Episodes of one zone (E23a): days in the zone, grouped so that a gap of more than 90 days starts a new
 * episode; per episode the forward multiples at 1/2/4 years against the same-era baseline (every day within
 * two years either side of the start, i.e. roughly buying every day in that era).
 */
export function episodes(s: SpotSeries, key: EpisodeZoneKey, r: Rulers = rulers(s)): EpisodeResult {
  const zone = EPISODE_ZONES.find((z) => z.key === key)!;
  const P = s.price;
  const LAST = P.length - 1;
  const lp = P.map(Math.log);
  const fwd = (i: number, h: number) => (i + h <= LAST ? lp[i + h] - lp[i] : null);
  const { f, from: from0 } = zoneTest(key, r);
  const from = Math.max(0, from0);
  const empty = { zone, from: from0 < 0 ? "" : s.day[from], totalDays: 0, rows: [], summary: [] };
  if (from0 < 0) return empty;
  const days: number[] = [];
  for (let i = from; i <= LAST; i++) if (f(i)) days.push(i);
  const eps: number[][] = [];
  for (const i of days) {
    const e = eps[eps.length - 1];
    if (e && i - e[e.length - 1] <= SPOT_RULES.episodeGapDays) e.push(i);
    else eps.push([i]);
  }
  const H = SPOT_RULES.horizons;
  // per episode and horizon: mean log return of the episode's days and of its baseline
  const cell = (e: number[], h: number) => {
    const a = e.map((i) => fwd(i, h)).filter((x): x is number => x != null);
    if (!a.length) return null;
    const st = e[0];
    const lo = Math.max(from, st - SPOT_RULES.baselineDays),
      hi = Math.min(LAST - h, st + SPOT_RULES.baselineDays);
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += lp[i + h] - lp[i];
    return { a: mean(a), b: sum / (hi - lo + 1) };
  };
  const rows: EpisodeRow[] = eps.map((e) => {
    const st = e[0],
      entry = P[st];
    let mi = st;
    for (let j = st; j <= Math.min(LAST, st + SPOT_RULES.drawdownDays); j++) if (P[j] < P[mi]) mi = j;
    let rec = -1;
    for (let j = mi + 1; j <= LAST; j++)
      if (P[j] >= entry) {
        rec = j;
        break;
      }
    return {
      start: s.day[st],
      end: s.day[e[e.length - 1]],
      days: e.length,
      entry,
      low: P[mi],
      lowDay: s.day[mi],
      drawdownPct: r1((P[mi] / entry - 1) * 100),
      recoverDay: rec < 0 ? null : s.day[rec],
      recoverDays: rec < 0 ? null : rec - st,
      horizons: H.map((h) => {
        const c = cell(e, h);
        return { days: h, mult: c ? Math.exp(c.a) : null, base: c ? Math.exp(c.b) : null };
      }),
    };
  });
  const summary: EpisodeSummary[] = H.map((h) => {
    const ed = eps.map((e) => cell(e, h)).filter((c): c is { a: number; b: number } => c != null).map((c) => c.a - c.b);
    const better = ed.filter((d) => d > 0).length;
    const consistent = ed.length > 0 && (ed.every((d) => d > 0) || ed.every((d) => d < 0));
    return { days: h, n: ed.length, better, ratio: ed.length ? Math.exp(mean(ed)) : null, consistent, verdict: episodeVerdict(ed.length, consistent) };
  });
  return { zone, from: s.day[from], totalDays: days.length, rows, summary };
}

// ---------------------------------------------------------------- Fear & Greed

export interface FngPoint {
  day: string;
  value: number;
}

export interface FngBlock {
  day: string;
  value: number;
  label: string;
  pct: number | null;
  zone: ZoneLabel | null;
  ago7: number | null;
  ago30: number | null;
}

/** Today's Fear & Greed (the latest point, which can be a day newer than the price data), a week and a month ago. */
export function fngBlock(points: FngPoint[]): FngBlock | null {
  if (!points.length) return null;
  const last = points[points.length - 1];
  const by = new Map(points.map((x) => [x.day, x.value]));
  const n = dayNum(last.day);
  const pct = expandingPercentile(points.map((x) => x.value))[points.length - 1];
  return { day: last.day, value: last.value, label: fngLabel(last.value)!, pct, zone: pctZone(pct), ago7: by.get(dayStr(n - 7)) ?? null, ago30: by.get(dayStr(n - 30)) ?? null };
}

// ---------------------------------------------------------------- planner references

export interface PriceRef {
  label: string;
  price: number;
  /** calc: computed from data; opinion: someone's view (the market-cap zones) */
  kind: "calc" | "opinion";
}

/** Reference prices for the accumulation planner: the computed lines and the opinion zones' edges (zero edges left out). */
export function spotRefs(now: SpotNow, zones: CapZonePrice[] = []): PriceRef[] {
  const out: PriceRef[] = [];
  if (now.wma.wma200) out.push({ label: "200 周均线", price: now.wma.wma200, kind: "calc" });
  if (now.mvrv.realizedPrice) out.push({ label: "全网平均成本（MVRV = 1）", price: now.mvrv.realizedPrice, kind: "calc" });
  if (now.mayer.ma200) {
    out.push({ label: "200 日均线", price: now.mayer.ma200, kind: "calc" });
    out.push({ label: "Mayer 0.8（200 日均线 × 0.8）", price: now.mayer.ma200 * SPOT_RULES.mayerLow, kind: "calc" });
  }
  for (const z of zones) {
    if (z.priceFrom === z.priceTo) {
      if (z.priceFrom > 0) out.push({ label: z.label, price: z.priceFrom, kind: "opinion" });
      continue;
    }
    if (z.priceFrom > 0) out.push({ label: `${z.label}下沿`, price: z.priceFrom, kind: "opinion" });
    if (z.priceTo > 0) out.push({ label: `${z.label}上沿`, price: z.priceTo, kind: "opinion" });
  }
  return out;
}
