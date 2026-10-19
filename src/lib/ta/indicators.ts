import type { Bias, Candle, Category } from "../types.ts";
import * as ta from "./core.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "../params.ts";

/**
 * Indicator panel. Every indicator yields a bias for every bar (so we can
 * replay history for resonance and win-rate stats) plus a plain-language
 * reason for the bar being inspected.
 */

export interface IndicatorReading {
  id: string;
  name: string;
  category: Category;
  bias: Bias;
  value: number | null;
  /** What it says right now, in plain words. */
  reason: string;
}

type BiasCode = 1 | -1 | 0;
interface Def {
  id: string;
  name: string;
  category: Category;
  run(ctx: Ctx): { bias: BiasCode[]; value: number[]; reason(i: number): string };
}

const pct = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
const fx = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));

class Ctx {
  private memo = new Map<string, unknown>();
  readonly c: Candle[];
  readonly close: number[];
  readonly p: EngineParams["indicators"];
  constructor(c: Candle[], p: EngineParams["indicators"]) {
    this.c = c;
    this.close = ta.closes(c);
    this.p = p;
  }
  get<T>(key: string, fn: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, fn());
    return this.memo.get(key) as T;
  }
  ema = (n: number) => this.get(`ema${n}`, () => ta.ema(this.close, n));
  sma = (n: number) => this.get(`sma${n}`, () => ta.sma(this.close, n));
  rsi = () => this.get("rsi", () => ta.rsi(this.close, 14));
  macd = () => this.get("macd", () => ta.macd(this.close));
  atr = () => this.get("atr", () => ta.atr(this.c, 14));
  volSma = () => this.get("volsma", () => ta.sma(ta.volumes(this.c), 20));
}

const map = (n: number, f: (i: number) => BiasCode): BiasCode[] => Array.from({ length: n }, (_, i) => f(i));

// ---------------------------------------------------------------- patterns

function body(x: Candle) {
  return Math.abs(x.c - x.o);
}
function range(x: Candle) {
  return x.h - x.l || 1e-12;
}
const isUp = (x: Candle) => x.c > x.o;
const isDown = (x: Candle) => x.c < x.o;

/** Returns [bias, label] for the candle pattern completing at bar i. */
export function candlePattern(c: Candle[], i: number, atr: number): [BiasCode, string] | null {
  if (i < 3 || Number.isNaN(atr)) return null;
  const a = c[i - 2], b = c[i - 1], x = c[i];
  const bx = body(x), rx = range(x);
  const upperWick = x.h - Math.max(x.o, x.c);
  const lowerWick = Math.min(x.o, x.c) - x.l;
  // Recent direction for context (hammer only matters after a drop, etc.)
  const drift = (x.c - c[Math.max(0, i - 6)].c) / atr;

  if (isDown(a) && body(a) > 0.6 * atr && body(b) < 0.3 * atr && isUp(x) && x.c > (a.o + a.c) / 2) return [1, "早晨之星"];
  if (isUp(a) && body(a) > 0.6 * atr && body(b) < 0.3 * atr && isDown(x) && x.c < (a.o + a.c) / 2) return [-1, "黄昏之星"];
  if (isDown(b) && isUp(x) && x.c >= b.o && x.o <= b.c && bx > body(b) * 1.05 && bx > 0.4 * atr) return [1, "看涨吞没"];
  if (isUp(b) && isDown(x) && x.c <= b.o && x.o >= b.c && bx > body(b) * 1.05 && bx > 0.4 * atr) return [-1, "看跌吞没"];
  if ([a, b, x].every(isUp) && b.c > a.c && x.c > b.c && [a, b, x].every((k) => body(k) > 0.5 * atr)) return [1, "红三兵"];
  if ([a, b, x].every(isDown) && b.c < a.c && x.c < b.c && [a, b, x].every((k) => body(k) > 0.5 * atr)) return [-1, "三只乌鸦"];
  if (drift < -1.5 && lowerWick > 2 * bx && upperWick < 0.3 * rx && rx > 0.6 * atr) return [1, "锤子线"];
  if (drift > 1.5 && upperWick > 2 * bx && lowerWick < 0.3 * rx && rx > 0.6 * atr) return [-1, "射击之星"];
  if (drift < -1 && Math.abs(b.l - x.l) < 0.05 * atr && isDown(b) && isUp(x)) return [1, "平头底"];
  if (drift > 1 && Math.abs(b.h - x.h) < 0.05 * atr && isUp(b) && isDown(x)) return [-1, "平头顶"];
  return null;
}

// ---------------------------------------------------------------- divergence

/** Pivot lows/highs confirmed `right` bars later. */
function pivots(src: number[], left: number, right: number, kind: "low" | "high"): number[] {
  const out: number[] = [];
  for (let i = left; i < src.length - right; i++) {
    let ok = true;
    for (let j = i - left; j <= i + right && ok; j++) {
      if (j === i) continue;
      if (kind === "low" ? src[j] < src[i] : src[j] > src[i]) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Regular RSI divergence; signal appears on the bar the second pivot is confirmed. */
function rsiDivergence(c: Candle[], r: number[]): { bias: BiasCode[]; label: string[] } {
  const n = c.length;
  const bias: BiasCode[] = new Array(n).fill(0);
  const label: string[] = new Array(n).fill("");
  const R = 3;
  const lowsIdx = pivots(ta.lows(c), 5, R, "low");
  const highsIdx = pivots(ta.highs(c), 5, R, "high");
  const mark = (idx: number[], kind: "low" | "high") => {
    for (let k = 1; k < idx.length; k++) {
      const p1 = idx[k - 1], p2 = idx[k];
      if (p2 - p1 < 5 || p2 - p1 > 60) continue;
      const confirm = p2 + R;
      if (confirm >= n) continue;
      const bullish = kind === "low" && c[p2].l < c[p1].l && r[p2] > r[p1] && r[p1] < 40;
      const bearish = kind === "high" && c[p2].h > c[p1].h && r[p2] < r[p1] && r[p1] > 60;
      if (!bullish && !bearish) continue;
      // keep the signal alive for a few bars after confirmation
      for (let j = confirm; j < Math.min(n, confirm + 5); j++) {
        bias[j] = bullish ? 1 : -1;
        label[j] = bullish ? "价格创新低，但 RSI 没有，跌势在减弱（底背离）" : "价格创新高，但 RSI 没有，涨势在减弱（顶背离）";
      }
    }
  };
  mark(lowsIdx, "low");
  mark(highsIdx, "high");
  return { bias, label };
}

/** Relative gap between +DI and −DI, 0 … 1. */
export function diSpread(d: { pdi: number[]; mdi: number[] }, i: number) {
  const sum = d.pdi[i] + d.mdi[i];
  return sum > 0 ? Math.abs(d.pdi[i] - d.mdi[i]) / sum : 0;
}

// ---------------------------------------------------------------- definitions

const DEFS: Def[] = [
  // ---------------- trend
  {
    id: "ema_cross",
    name: "EMA 快慢线 (12/26)",
    category: "trend",
    run(x) {
      const f = x.ema(12), s = x.ema(26);
      const v = f.map((a, i) => ((a - s[i]) / s[i]) * 100);
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : v[i] > 0 ? 1 : -1)),
        value: v,
        reason: (i) => (v[i] > 0 ? `短期均线在长期均线上方 ${pct(v[i])}，近期买盘占优` : `短期均线在长期均线下方 ${pct(v[i])}，近期卖盘占优`),
      };
    },
  },
  {
    id: "golden_cross",
    name: "金叉/死叉 (50/200)",
    category: "trend",
    run(x) {
      const a = x.sma(50), b = x.sma(200);
      const v = a.map((m, i) => ((m - b[i]) / b[i]) * 100);
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : v[i] > 0 ? 1 : -1)),
        value: v,
        reason: (i) => (v[i] > 0 ? "50 线在 200 线上方（金叉状态），大方向偏多" : "50 线在 200 线下方（死叉状态），大方向偏空"),
      };
    },
  },
  {
    id: "ma_stack",
    name: "均线排列 (20/50/100)",
    category: "trend",
    run(x) {
      const a = x.ema(20), b = x.ema(50), c = x.ema(100);
      const bias = map(a.length, (i) => (Number.isNaN(c[i]) ? 0 : a[i] > b[i] && b[i] > c[i] ? 1 : a[i] < b[i] && b[i] < c[i] ? -1 : 0));
      return {
        bias,
        value: a.map((v, i) => ((v - c[i]) / c[i]) * 100),
        reason: (i) => (bias[i] === 1 ? "短、中、长均线从上到下依次排列（多头排列），趋势健康" : bias[i] === -1 ? "短、中、长均线从下到上依次排列（空头排列），趋势走弱" : "均线互相缠绕，方向不明"),
      };
    },
  },
  {
    id: "price_sma200",
    name: "价格 vs 200 均线",
    category: "trend",
    run(x) {
      const m = x.sma(200);
      const v = x.close.map((p, i) => ((p - m[i]) / m[i]) * 100);
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : v[i] > 0 ? 1 : -1)),
        value: v,
        reason: (i) => (v[i] > 0 ? `价格在长期均线上方 ${pct(v[i])}` : `价格在长期均线下方 ${pct(v[i])}`),
      };
    },
  },
  {
    id: "macd",
    name: "MACD",
    category: "trend",
    run(x) {
      const m = x.macd();
      return {
        bias: map(m.hist.length, (i) => (Number.isNaN(m.hist[i]) ? 0 : m.line[i] > m.signal[i] ? 1 : -1)),
        value: m.hist,
        reason: (i) => {
          const crossUp = m.hist[i] > 0 && m.hist[i - 1] <= 0;
          const crossDn = m.hist[i] < 0 && m.hist[i - 1] >= 0;
          if (crossUp) return "MACD 刚刚金叉，上涨动力开始增强";
          if (crossDn) return "MACD 刚刚死叉，下跌动力开始增强";
          return m.hist[i] > 0 ? (m.hist[i] > m.hist[i - 1] ? "MACD 在信号线上方且在扩大，多头加速" : "MACD 在信号线上方但在收窄，多头放缓") : m.hist[i] < m.hist[i - 1] ? "MACD 在信号线下方且在扩大，空头加速" : "MACD 在信号线下方但在收窄，空头放缓";
        },
      };
    },
  },
  {
    id: "adx",
    name: "ADX / DMI",
    category: "trend",
    run(x) {
      const d = x.get("adx", () => ta.adx(x.c, 14));
      return {
        // a high ADX with +DI ≈ −DI means the old trend is fading, not a direction
        bias: map(x.c.length, (i) => (Number.isNaN(d.adx[i]) || d.adx[i] < 20 || diSpread(d, i) < 0.1 ? 0 : d.pdi[i] > d.mdi[i] ? 1 : -1)),
        value: d.adx,
        reason: (i) =>
          d.adx[i] < 20
            ? `ADX ${fx(d.adx[i])} 低于 20，市场没有明确趋势（震荡）`
            : diSpread(d, i) < 0.1
              ? `ADX ${fx(d.adx[i])}，但上涨力量（+DI ${fx(d.pdi[i])}）和下跌力量（−DI ${fx(d.mdi[i])}）几乎相当，原有趋势在减弱`
              : `ADX ${fx(d.adx[i])}，${d.adx[i] > 40 ? "趋势很强" : "趋势成形"}，方向${d.pdi[i] > d.mdi[i] ? "向上" : "向下"}`,
      };
    },
  },
  {
    id: "psar",
    name: "抛物线 SAR",
    category: "trend",
    run(x) {
      const p = x.get("psar", () => ta.psar(x.c));
      return {
        bias: p.dir.map((d) => (d > 0 ? 1 : d < 0 ? -1 : 0)) as BiasCode[],
        value: p.sar,
        reason: (i) => (p.dir[i] > 0 ? `SAR 点在价格下方（${fx(p.sar[i])}），上升跟踪中` : `SAR 点在价格上方（${fx(p.sar[i])}），下降跟踪中`),
      };
    },
  },
  {
    id: "aroon",
    name: "Aroon",
    category: "trend",
    run(x) {
      const a = x.get("aroon", () => ta.aroon(x.c, 25));
      return {
        bias: map(x.c.length, (i) => (Number.isNaN(a.up[i]) ? 0 : a.up[i] > 70 && a.up[i] > a.down[i] ? 1 : a.down[i] > 70 && a.down[i] > a.up[i] ? -1 : 0)),
        value: a.up.map((u, i) => u - a.down[i]),
        reason: (i) => (a.up[i] > 70 && a.up[i] > a.down[i] ? "最近频繁创新高" : a.down[i] > 70 && a.down[i] > a.up[i] ? "最近频繁创新低" : "新高新低都不明显"),
      };
    },
  },
  {
    id: "ichimoku",
    name: "一目均衡云",
    category: "trend",
    run(x) {
      const k = x.get("ichi", () => ta.ichimoku(x.c));
      const bias = map(x.c.length, (i) => {
        const top = Math.max(k.senkouA[i], k.senkouB[i]), bot = Math.min(k.senkouA[i], k.senkouB[i]);
        if (Number.isNaN(top)) return 0;
        return x.close[i] > top ? 1 : x.close[i] < bot ? -1 : 0;
      });
      return {
        bias,
        value: k.kijun,
        reason: (i) => (bias[i] === 1 ? "价格在云层上方，云层是下方支撑" : bias[i] === -1 ? "价格在云层下方，云层是上方压力" : "价格在云层里，多空拉锯"),
      };
    },
  },
  {
    id: "slope",
    name: "回归斜率 (20)",
    category: "trend",
    run(x) {
      const s = x.get("slope", () => ta.regressionSlope(x.close, 20));
      return {
        bias: map(s.length, (i) => (Number.isNaN(s[i]) ? 0 : s[i] > 0.05 ? 1 : s[i] < -0.05 ? -1 : 0)),
        value: s,
        reason: (i) => `最近 20 根 K 线的平均方向：每根 ${pct(s[i], 3)}`,
      };
    },
  },

  // ---------------- momentum
  {
    id: "rsi",
    name: "RSI (14)",
    category: "momentum",
    run(x) {
      const r = x.rsi();
      const { rsiLow: lo, rsiHigh: hi } = x.p;
      return {
        bias: map(r.length, (i) => (Number.isNaN(r[i]) ? 0 : r[i] < lo ? 1 : r[i] > hi ? -1 : 0)),
        value: r,
        reason: (i) => (r[i] < lo ? `RSI ${fx(r[i])}，跌得过急（超卖），容易反弹` : r[i] > hi ? `RSI ${fx(r[i])}，涨得过急（超买），容易回调` : `RSI ${fx(r[i])}，处在正常区间`),
      };
    },
  },
  {
    id: "rsi_div",
    name: "RSI 背离",
    category: "momentum",
    run(x) {
      const d = x.get("rsidiv", () => rsiDivergence(x.c, x.rsi()));
      return { bias: d.bias, value: x.rsi(), reason: (i) => d.label[i] || "最近没有背离" };
    },
  },
  {
    id: "stoch",
    name: "随机指标 KD",
    category: "momentum",
    run(x) {
      const s = x.get("stoch", () => ta.stochastic(x.c));
      return {
        bias: map(x.c.length, (i) => (Number.isNaN(s.d[i]) ? 0 : s.k[i] < 25 && s.k[i] > s.d[i] ? 1 : s.k[i] > 75 && s.k[i] < s.d[i] ? -1 : 0)),
        value: s.k,
        reason: (i) => (s.k[i] < 25 ? (s.k[i] > s.d[i] ? "低位金叉，短线可能反弹" : "处于低位，还没拐头") : s.k[i] > 75 ? (s.k[i] < s.d[i] ? "高位死叉，短线可能回落" : "处于高位，还没拐头") : `K 值 ${fx(s.k[i])}，中性`),
      };
    },
  },
  {
    id: "cci",
    name: "CCI (20)",
    category: "momentum",
    run(x) {
      const v = x.get("cci", () => ta.cci(x.c, 20));
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : v[i] < -150 ? 1 : v[i] > 150 ? -1 : 0)),
        value: v,
        reason: (i) => (v[i] < -150 ? `CCI ${fx(v[i])}，明显偏离均值，偏低` : v[i] > 150 ? `CCI ${fx(v[i])}，明显偏离均值，偏高` : `CCI ${fx(v[i])}，正常波动`),
      };
    },
  },
  {
    id: "willr",
    name: "威廉指标 %R",
    category: "momentum",
    run(x) {
      const v = x.get("willr", () => ta.williamsR(x.c, 14));
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : v[i] < -85 ? 1 : v[i] > -15 ? -1 : 0)),
        value: v,
        reason: (i) => (v[i] < -85 ? "收盘接近近期最低价，超卖" : v[i] > -15 ? "收盘接近近期最高价，超买" : "位于近期区间中部"),
      };
    },
  },
  {
    id: "roc",
    name: "变动率 ROC (12)",
    category: "momentum",
    run(x) {
      const v = x.get("roc", () => ta.roc(x.close, 12));
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : v[i] > 0.5 ? 1 : v[i] < -0.5 ? -1 : 0)),
        value: v,
        reason: (i) => `和 12 根 K 线前相比 ${pct(v[i])}`,
      };
    },
  },
  {
    id: "mfi",
    name: "资金流量 MFI",
    category: "momentum",
    run(x) {
      const v = x.get("mfi", () => ta.mfi(x.c, 14));
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : v[i] < 20 ? 1 : v[i] > 80 ? -1 : 0)),
        value: v,
        reason: (i) => (v[i] < 20 ? `MFI ${fx(v[i])}，资金流出过度（超卖）` : v[i] > 80 ? `MFI ${fx(v[i])}，资金流入过热（超买）` : `MFI ${fx(v[i])}，资金进出平衡`),
      };
    },
  },

  // ---------------- volatility
  {
    id: "bollinger",
    name: "布林带",
    category: "volatility",
    run(x) {
      const b = x.get("bb", () => ta.bollinger(x.close));
      const pos = x.close.map((p, i) => (p - b.lower[i]) / (b.upper[i] - b.lower[i]));
      return {
        bias: map(pos.length, (i) => (Number.isNaN(pos[i]) ? 0 : pos[i] < 0 ? 1 : pos[i] > 1 ? -1 : 0)),
        value: pos.map((v) => v * 100),
        reason: (i) => (pos[i] < 0 ? "跌破布林下轨，短期偏离过大，可能回归" : pos[i] > 1 ? "突破布林上轨，短期偏离过大，可能回落" : `位于布林带 ${Math.round(pos[i] * 100)}% 位置`),
      };
    },
  },
  {
    id: "squeeze",
    name: "布林收口",
    category: "volatility",
    run(x) {
      const b = x.get("bb", () => ta.bollinger(x.close));
      const minW = ta.lowest(b.width.map((v) => (Number.isNaN(v) ? Infinity : v)), 120);
      return {
        bias: new Array(x.c.length).fill(0),
        value: b.width.map((v) => v * 100),
        reason: (i) => (b.width[i] <= minW[i] * 1.1 ? "布林带收得很窄，往往预示大行情即将出现（方向未定）" : `带宽 ${fx(b.width[i] * 100)}%，波动正常`),
      };
    },
  },
  {
    id: "keltner",
    name: "肯特纳通道",
    category: "volatility",
    run(x) {
      const k = x.get("kc", () => ta.keltner(x.c));
      return {
        bias: map(x.c.length, (i) => (Number.isNaN(k.upper[i]) ? 0 : x.close[i] > k.upper[i] ? 1 : x.close[i] < k.lower[i] ? -1 : 0)),
        value: k.mid,
        reason: (i) => (x.close[i] > k.upper[i] ? "强势冲出通道上沿，动能强" : x.close[i] < k.lower[i] ? "跌出通道下沿，抛压重" : "在通道内运行"),
      };
    },
  },
  {
    id: "atr",
    name: "ATR 波动幅度",
    category: "volatility",
    run(x) {
      const a = x.atr();
      const avg = ta.sma(a, 50);
      return {
        bias: new Array(x.c.length).fill(0),
        value: a.map((v, i) => (v / x.close[i]) * 100),
        reason: (i) => `平均每根 K 线波动 ${fx((a[i] / x.close[i]) * 100)}%，${a[i] > avg[i] * 1.3 ? "比平时大，注意控制仓位" : a[i] < avg[i] * 0.75 ? "比平时小，市场平静" : "和平时差不多"}`,
      };
    },
  },

  // ---------------- volume
  {
    id: "obv",
    name: "能量潮 OBV",
    category: "volume",
    run(x) {
      const o = x.get("obv", () => ta.obv(x.c));
      const e = ta.ema(o, 20);
      return {
        bias: map(o.length, (i) => (Number.isNaN(e[i]) ? 0 : o[i] > e[i] ? 1 : -1)),
        value: o,
        reason: (i) => (o[i] > e[i] ? "上涨时的成交量多于下跌时，资金在流入" : "下跌时的成交量多于上涨时，资金在流出"),
      };
    },
  },
  {
    id: "cmf",
    name: "蔡金资金流 CMF",
    category: "volume",
    run(x) {
      const v = x.get("cmf", () => ta.cmf(x.c, 20));
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : v[i] > 0.05 ? 1 : v[i] < -0.05 ? -1 : 0)),
        value: v,
        reason: (i) => (v[i] > 0.05 ? "收盘多靠近高点，买方更积极" : v[i] < -0.05 ? "收盘多靠近低点，卖方更积极" : "买卖力量接近"),
      };
    },
  },
  {
    id: "adl",
    name: "累积/派发线",
    category: "volume",
    run(x) {
      const a = x.get("adl", () => ta.adl(x.c));
      const e = ta.ema(a, 20);
      return {
        bias: map(a.length, (i) => (Number.isNaN(e[i]) ? 0 : a[i] > e[i] ? 1 : -1)),
        value: a,
        reason: (i) => (a[i] > e[i] ? "近期在吸筹（累积）" : "近期在出货（派发）"),
      };
    },
  },
  {
    id: "force",
    name: "强力指数",
    category: "volume",
    run(x) {
      const f = x.get("force", () => ta.forceIndex(x.c, 13));
      return {
        bias: map(f.length, (i) => (Number.isNaN(f[i]) ? 0 : f[i] > 0 ? 1 : -1)),
        value: f,
        reason: (i) => (f[i] > 0 ? "价格上涨且有成交量配合" : "价格下跌且有成交量配合"),
      };
    },
  },
  {
    id: "vwap",
    name: "成交均价 VWAP (20)",
    category: "volume",
    run(x) {
      const v = x.get("vwap", () => ta.rollingVwap(x.c, 20));
      return {
        bias: map(v.length, (i) => (Number.isNaN(v[i]) ? 0 : x.close[i] > v[i] ? 1 : -1)),
        value: v,
        reason: (i) => (x.close[i] > v[i] ? `价格高于近期成交均价 ${fx(v[i])}，多数近期买家赚钱` : `价格低于近期成交均价 ${fx(v[i])}，多数近期买家被套`),
      };
    },
  },
  {
    id: "vol_ratio",
    name: "量比",
    category: "volume",
    run(x) {
      const avg = x.volSma();
      const r = x.c.map((k, i) => k.v / avg[i]);
      return {
        bias: map(r.length, (i) => (Number.isNaN(r[i]) || r[i] < 1.5 ? 0 : isUp(x.c[i]) ? 1 : isDown(x.c[i]) ? -1 : 0)),
        value: r,
        reason: (i) => (r[i] >= 1.5 ? `成交量是平时的 ${r[i].toFixed(1)} 倍，${isUp(x.c[i]) ? "放量上涨" : "放量下跌"}` : `成交量是平时的 ${r[i].toFixed(1)} 倍，不算异常`),
      };
    },
  },

  // ---------------- patterns
  {
    id: "candles",
    name: "K 线形态",
    category: "pattern",
    run(x) {
      const a = x.atr();
      const res = x.c.map((_, i) => candlePattern(x.c, i, a[i]));
      return {
        bias: res.map((r) => (r ? r[0] : 0)) as BiasCode[],
        value: new Array(x.c.length).fill(NaN),
        reason: (i) => (res[i] ? `出现「${res[i]![1]}」${res[i]![0] > 0 ? "，常见的见底信号" : "，常见的见顶信号"}` : "没有明显的反转形态"),
      };
    },
  },
];

export interface IndicatorPanel {
  readings: IndicatorReading[];
  summary: Record<Category, { bull: number; bear: number; neutral: number }>;
  /** Net bull-minus-bear for every bar. */
  net: number[];
  bullCount: number[];
  bearCount: number[];
  byId: Map<string, BiasCode[]>;
}

const toBias = (b: BiasCode): Bias => (b > 0 ? "bull" : b < 0 ? "bear" : "neutral");

export function computeIndicators(candles: Candle[], at = candles.length - 1, ip: EngineParams["indicators"] = DEFAULT_ENGINE_PARAMS.indicators): IndicatorPanel {
  const ctx = new Ctx(candles, ip);
  const n = candles.length;
  const net = new Array(n).fill(0);
  const bullCount = new Array(n).fill(0);
  const bearCount = new Array(n).fill(0);
  const readings: IndicatorReading[] = [];
  const byId = new Map<string, BiasCode[]>();
  const summary = Object.fromEntries(
    (["trend", "momentum", "volatility", "volume", "pattern"] as Category[]).map((k) => [k, { bull: 0, bear: 0, neutral: 0 }]),
  ) as IndicatorPanel["summary"];

  for (const def of DEFS) {
    if (!ip.enabled.has(def.id)) continue;
    const r = def.run(ctx);
    byId.set(def.id, r.bias);
    for (let i = 0; i < n; i++) {
      if (r.bias[i] > 0) bullCount[i]++;
      else if (r.bias[i] < 0) bearCount[i]++;
      net[i] += r.bias[i];
    }
    const b = toBias(r.bias[at]);
    const val = r.value[at];
    readings.push({
      id: def.id,
      name: def.name,
      category: def.category,
      bias: b,
      value: Number.isFinite(val) ? val : null,
      reason: r.reason(at),
    });
    summary[def.category][b === "bull" ? "bull" : b === "bear" ? "bear" : "neutral"]++;
  }
  return { readings, summary, net, bullCount, bearCount, byId };
}

export const INDICATOR_COUNT = DEFS.length;
