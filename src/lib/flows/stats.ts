/**
 * The ETF 买盘 page's arithmetic: US spot BTC ETF daily net flows (size, 3- and 7-day sums, streaks, each ranked
 * against the previous 120 trading days) and the Coinbase premarket premium Z (the premium net of the USDT peg,
 * averaged over 北京 16:00–21:00, against the previous 60 trading days). Pure functions, shared by the page,
 * the CLI and the tests.
 *
 * Description only. E26 / E26b (project folder e26/): no flow rule predicts the next 1–7 days, flows move with the
 * price on the same day (correlation 0.46) and not after (0.05); the premarket Z tells which way today's ETF flow
 * is likely to go (Z ≥ 1: about 80% inflow days against 58% on all days), and its tilt on the BTC price did not
 * survive a shift of the decision hour, the lookback or the coin. The page may only say what `FLOW_FACTS` says.
 */

export const FLOW_RULES = {
  /** trading days a day's flow (and the 3- / 7-day sums) is ranked against */
  lookback: 120,
  /** trading days the premarket premium is compared with */
  zLookback: 60,
  /** premarket window: hourly bars opening at these UTC hours (北京 16:00–21:00, 美东 04:00–09:00 in summer) */
  premarketHours: [8, 9, 10, 11, 12],
  /** at least this many of those hourly bars, or the day has no premarket value */
  premarketMinBars: 4,
  /** UTC hour the premarket value is final (北京 21:00) */
  premarketFinalHour: 13,
  /** the US session the Z table measures: 13:00 → 20:00 UTC */
  sessionHours: 7,
};

/** Fixed sentences: the only direction-related claims the page makes. */
export const FLOW_FACTS = {
  flowNoEdge:
    "研究（E26）：当天流入大小、近 3 日 / 7 日合计、连续流入或流出的天数，对之后 1 天、3 天、7 天的涨跌都没有可证明的预测力（45 条规则，0 条达标）。",
  flowFollowsPrice: "大额流入多出现在已经涨了的日子：流入和当天涨跌的相关系数约 0.46，和之后一天约 0.05。资金是跟着价格走的，别因为一天的大流入去追。",
  comboNoEdge:
    "加上日线结构、50 周均线、资金费率、持仓量一起看（E26b，事先定好的 7 种组合），也没有一种能稳定地比随便哪天好。",
  zFlow: "盘前溢价 Z 能提前告诉你今天 ETF 大概率是流入还是流出：Z ≥ 1 时历史上约八成是净流入，平时不到六成。",
  zPrice: "对 BTC 价格只有一点倾向：Z ≥ 1 / ≤ −1 之后当天美股时段略好于随机，但换一个时间点或回看天数、换成 ETH 就不显著，算“候选，未达标”，不当买卖信号。",
  precursor:
    "倒过来查（E26b）：之后 7 天涨跌超过 10% 的 12 次大行情里，7 次之前出现过两项以上异常（流入很大、盘前 Z 很高或很低、资金费率拥挤、持仓量暴增暴减、波动率压缩），但同样的情况一共出现 50 次，43 次之后什么也没发生，也分不出方向。",
  delay: "ETF 的流入数字在美股收盘后陆续公布，完整的一般要到北京时间第二天早上，之后还可能修正；美国节假日没有新数字。",
};

export interface FlowDay {
  /** US trading day, YYYY-MM-DD */
  day: string;
  /** net flow, USD */
  flow: number;
  /** total net assets after the day, USD */
  aum: number | null;
  /** per-fund net flow, USD */
  perEtf: Record<string, number> | null;
}

export type BuyState = "强" | "偏强" | "平常" | "偏弱" | "弱";

/** Share of `past` strictly below `x` (0–1). */
export function rankIn(x: number, past: number[]): number {
  if (!past.length) return NaN;
  let n = 0;
  for (const v of past) if (v < x) n++;
  return n / past.length;
}

const sumAt = (f: number[], i: number, k: number) => {
  let s = 0;
  for (let j = Math.max(0, i - k + 1); j <= i; j++) s += f[j];
  return s;
};

/** How strong US buying has been, from the 7-day sum's rank. */
export function buyState(p7: number): BuyState {
  return p7 >= 0.9 ? "强" : p7 >= 0.7 ? "偏强" : p7 > 0.3 ? "平常" : p7 > 0.1 ? "偏弱" : "弱";
}

export interface FlowNow {
  day: string;
  flow: number;
  /** rank among the previous `lookback` trading days, 0–1 */
  pct: number;
  sum3: number;
  p3: number;
  sum7: number;
  p7: number;
  /** consecutive days on this side, + for inflows, − for outflows */
  streak: number;
  aum: number | null;
  /** flow as % of the assets */
  aumPct: number | null;
  /** cumulative net flow of the stored history, USD */
  cumulative: number;
  state: BuyState;
}

/** The flow picture on day `i` (default: the latest). Null until `lookback + 7` days are stored. */
export function flowNow(days: FlowDay[], i = days.length - 1, lookback = FLOW_RULES.lookback): FlowNow | null {
  if (i < lookback + 6 || i >= days.length) return null;
  const f = days.map((d) => d.flow);
  const past = f.slice(i - lookback, i);
  const past3: number[] = [];
  const past7: number[] = [];
  for (let j = i - lookback; j < i; j++) {
    past3.push(sumAt(f, j, 3));
    past7.push(sumAt(f, j, 7));
  }
  let streak = 0;
  const side = Math.sign(f[i]);
  for (let j = i; j >= 0 && side !== 0 && Math.sign(f[j]) === side; j--) streak++;
  const sum3 = sumAt(f, i, 3);
  const sum7 = sumAt(f, i, 7);
  const p7 = rankIn(sum7, past7);
  let cumulative = 0;
  for (let j = 0; j <= i; j++) cumulative += f[j];
  const aum = days[i].aum;
  return {
    day: days[i].day,
    flow: f[i],
    pct: rankIn(f[i], past),
    sum3,
    p3: rankIn(sum3, past3),
    sum7,
    p7,
    streak: side * streak,
    aum,
    aumPct: aum ? (f[i] / aum) * 100 : null,
    cumulative,
    state: buyState(p7),
  };
}

/** Coinbase BTC-USD against Binance BTCUSDT priced in USD (the USDT peg removed): a fraction, + = Coinbase higher. */
export function truePremium(cb: number, bn: number, usdt: number): number {
  return cb / (bn * usdt) - 1;
}

/** Coinbase against Binance as quoted (USDT taken as $1). */
export function nominalPremium(cb: number, bn: number): number {
  return cb / bn - 1;
}

export interface HourPremium {
  /** open time of the hourly bar, Unix seconds (UTC) */
  t: number;
  /** true premium at the bar's close */
  prem: number;
}

/**
 * Each weekday's premarket premium: the mean over the premarket bars, when enough of them exist. Weekends have no
 * US session and are left out, so the Z lookback counts trading days as in E26.
 */
export function premarketDays(hours: HourPremium[], rules = FLOW_RULES): { day: string; prem: number; bars: number }[] {
  const by = new Map<string, number[]>();
  for (const h of hours) {
    const d = new Date(h.t * 1000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || !rules.premarketHours.includes(d.getUTCHours())) continue;
    const k = d.toISOString().slice(0, 10);
    const a = by.get(k);
    if (a) a.push(h.prem);
    else by.set(k, [h.prem]);
  }
  return [...by]
    .filter(([, a]) => a.length >= rules.premarketMinBars)
    .map(([day, a]) => ({ day, prem: a.reduce((s, x) => s + x, 0) / a.length, bars: a.length }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/**
 * Z of `value` against the previous `zLookback` premarket values in `history` (all strictly earlier days).
 * Null with too little history or no spread.
 */
export function premiumZ(value: number, history: number[], lookback = FLOW_RULES.zLookback): number | null {
  if (history.length < lookback) return null;
  const w = history.slice(-lookback);
  const s = sd(w);
  return s > 0 ? (value - mean(w)) / s : null;
}

/** Z of every day with a full lookback before it. */
export function zSeries(days: { day: string; prem: number }[], lookback = FLOW_RULES.zLookback): { day: string; prem: number; z: number }[] {
  const out: { day: string; prem: number; z: number }[] = [];
  for (let i = lookback; i < days.length; i++) {
    const z = premiumZ(days[i].prem, days.slice(i - lookback, i).map((x) => x.prem), lookback);
    if (z != null) out.push({ day: days[i].day, prem: days[i].prem, z });
  }
  return out;
}

export type ZBand = "买盘强" | "偏买" | "略偏买" | "平常" | "略偏卖" | "偏卖" | "卖盘强";
/** Bands of the Z gauge, high to low: Z ≥ `min` falls in the band. */
export const Z_BANDS: { min: number; band: ZBand; label: string }[] = [
  { min: 1.5, band: "买盘强", label: "≥ 1.5" },
  { min: 1, band: "偏买", label: "1 – 1.5" },
  { min: 0.7, band: "略偏买", label: "0.7 – 1" },
  { min: -0.7, band: "平常", label: "−0.7 – 0.7" },
  { min: -1, band: "略偏卖", label: "−1 – −0.7" },
  { min: -1.5, band: "偏卖", label: "−1.5 – −1" },
  { min: -Infinity, band: "卖盘强", label: "≤ −1.5" },
];

export function zBand(z: number): ZBand {
  return Z_BANDS.find((b) => z >= b.min)!.band;
}

export interface ZDay {
  day: string;
  z: number;
  /** that day's ETF net flow, if it was a trading day with a published number */
  flow: number | null;
  /** BTC change over the US session after the premarket (13:00 → 20:00 UTC), fraction */
  session: number | null;
}

export interface ZRow {
  band: ZBand | "所有日子";
  label: string;
  days: number;
  /** share of the band's days with a net inflow (days with a flow number only) */
  inflowPct: number | null;
  /** share with BTC up over the US session */
  upPct: number | null;
  /** mean session change, % */
  avgPct: number | null;
}

/** The Z table: per band, how often the ETF flow was an inflow and BTC rose over the session; last row all days. */
export function zTable(rows: ZDay[]): ZRow[] {
  const row = (band: ZRow["band"], label: string, a: ZDay[]): ZRow => {
    const f = a.filter((x) => x.flow != null);
    const s = a.filter((x) => x.session != null).map((x) => x.session!);
    return {
      band,
      label,
      days: a.length,
      inflowPct: f.length ? (f.filter((x) => x.flow! > 0).length / f.length) * 100 : null,
      upPct: s.length ? (s.filter((x) => x > 0).length / s.length) * 100 : null,
      avgPct: s.length ? mean(s) * 100 : null,
    };
  };
  const out = Z_BANDS.map((b) => row(b.band, b.label, rows.filter((x) => zBand(x.z) === b.band)));
  out.push(row("所有日子", "对照", rows));
  return out;
}

export interface AfterRow {
  /** holding period, days */
  days: number;
  n: number;
  /** mean change, % */
  avgPct: number;
  /** share of rises, % */
  upPct: number;
}

/** Mean change and share of rises over each horizon; `pick` returns the change for one row (null = not yet known). */
export function afterTable<T>(rows: T[], horizons: number[], pick: (r: T, h: number) => number | null): AfterRow[] {
  return horizons.map((h) => {
    const v = rows.map((r) => pick(r, h)).filter((x): x is number => x != null);
    return { days: h, n: v.length, avgPct: v.length ? mean(v) * 100 : NaN, upPct: v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : NaN };
  });
}

/** Pearson correlation; NaN with fewer than 3 pairs or no spread. */
export function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let s = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    s += (a[i] - ma) * (b[i] - mb);
    sa += (a[i] - ma) ** 2;
    sb += (b[i] - mb) ** 2;
  }
  return sa && sb ? s / Math.sqrt(sa * sb) : NaN;
}

/** Mean of `y` within each fifth of `x` (lowest fifth first): the "flows follow the price" chart. */
export function quintileMeans(x: number[], y: number[]): { lo: number; hi: number; mean: number; n: number }[] {
  const idx = x.map((v, i) => i).sort((i, j) => x[i] - x[j]);
  const out: { lo: number; hi: number; mean: number; n: number }[] = [];
  for (let q = 0; q < 5; q++) {
    const part = idx.slice(Math.floor((q * idx.length) / 5), Math.floor(((q + 1) * idx.length) / 5));
    if (!part.length) continue;
    out.push({ lo: x[part[0]], hi: x[part[part.length - 1]], mean: mean(part.map((i) => y[i])), n: part.length });
  }
  return out;
}
