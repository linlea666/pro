import type { Timeframe } from "../types.ts";
import { TF_HORIZON, TF_LABEL } from "../types.ts";
import { familyVotes, type IndicatorPanel } from "./indicators.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "../params.ts";
import type { Level } from "./levels.ts";
import type { TdState } from "./td.ts";
import type { TrendResult } from "./trend.ts";
import { DEFAULT_BUFFER_ATR, noiseProb, type Calibration } from "./risk.ts";

/**
 * The traffic light: one composite score per symbol/timeframe, translated
 * into plain language with a risk reference. Weights:
 * trend 40% · momentum & flow 25% · position vs levels 20% · TD timing 15%.
 *
 * The stop reference ("认错位") sits beyond the nearest intact structural swing
 * point, by the sweep depth that held levels typically suffer, and says how
 * likely ordinary noise is to reach it within the holding horizon.
 */

export type Light = "green" | "yellow" | "red";

export interface Component {
  key: "trend" | "momentum" | "position" | "timing";
  label: string;
  score: number;
  text: string;
}

export interface Verdict {
  light: Light;
  lightText: string;
  score: number;
  /** how many of the 4 components point the same way as the total (|score| ≥ 10); not a probability */
  agreement: number;
  headline: string;
  components: Component[];
  plan: string[];
  stopRef: number | null;
  stopText: string;
  /** structural swing point the stop is anchored to (null: fell back to the nearest level) */
  stopAnchor: number | null;
  /** distance from price to the stop, in ATR */
  stopAtr: number | null;
  /** % chance plain noise reaches the stop within the holding horizon (null: not calibrated yet) */
  stopNoisePct: number | null;
  /** a wider stop at the next structural point, offered when the first one is likely to be swept */
  stopAlt: number | null;
  atrPct: number;
}

export interface RiskInputs {
  /** sweep buffer beyond the anchor, in ATR */
  buffer: number;
  /** intact swing lows below price / highs above price, nearest first */
  below: number[];
  above: number[];
  cal: Calibration | null;
  /** e.g. "3 天" */
  horizonText: string;
}

const clamp = (v: number, a = -100, b = 100) => Math.max(a, Math.min(b, v));
export const fmtPrice = (v: number) =>
  v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(v >= 100 ? 1 : 3) : v.toPrecision(4);
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

export function timingScore(td: TdState, lastIdx: number): { score: number; text: string } {
  const ev = td.events[td.events.length - 1];
  if (ev && !td.current.lastSignal?.invalidated) {
    const age = lastIdx - ev.i;
    const fresh = ev.kind === "setup9" ? age <= 4 : age <= 8;
    if (fresh) {
      const base = ev.kind === "countdown13" ? 80 : ev.perfected ? 65 : 45;
      const dir = ev.side === "buy" ? 1 : -1;
      const name = ev.side === "buy" ? (ev.kind === "countdown13" ? "跌势 13（下跌已数满 13）" : "跌势 9（连跌满 9 根）") : ev.kind === "countdown13" ? "涨势 13（上涨已数满 13）" : "涨势 9（连涨满 9 根）";
      return { score: base * dir, text: `${age === 0 ? "本根" : `${age} 根前`}出现 TD ${name}，说明这段${dir > 0 ? "跌势" : "涨势"}已经走了很久，不预测接下来的方向` };
    }
  }
  const { setupSide, setupCount } = td.current;
  if (setupSide && setupCount >= 7 && setupCount <= 9) {
    return setupSide === "buy"
      ? { score: 20, text: `连续下跌计数到 ${setupCount}/9，下跌接近“歇脚”位置` }
      : { score: -20, text: `连续上涨计数到 ${setupCount}/9，上涨接近“歇脚”位置` };
  }
  if (setupSide) return { score: 0, text: `${setupSide === "buy" ? "下跌" : "上涨"}计数 ${setupCount}/9，时机信号不明显` };
  return { score: 0, text: "没有明显的时机信号" };
}

export function buildVerdict(args: {
  tf: Timeframe;
  price: number;
  atr: number;
  trend: TrendResult;
  panel: IndicatorPanel;
  td: TdState;
  supports: Level[];
  resistances: Level[];
  lastIdx: number;
  vp?: EngineParams["verdict"];
  risk?: RiskInputs;
}): Verdict {
  const W = args.vp ?? DEFAULT_ENGINE_PARAMS.verdict;
  const { tf, price, atr, trend, panel, td, supports, resistances, lastIdx } = args;

  // ---- momentum & flow: momentum, volume, pattern categories (or, optionally, their families: one vote each)
  let momentum: number, momText: string;
  if (W.familyVotes) {
    const fam = familyVotes(panel, lastIdx).filter((f) => f.flow);
    const fb = fam.filter((f) => f.score > 0).length, fs = fam.filter((f) => f.score < 0).length;
    momentum = clamp((fam.reduce((a, f) => a + f.score, 0) / Math.max(1, fam.length)) * 150);
    momText =
      fb > fs
        ? `动量和资金类 ${fam.length} 个指标家族：${fb} 个偏多、${fs} 个偏空，买盘${fb - fs >= 3 ? "明显" : "略"}占上风`
        : fs > fb
          ? `动量和资金类 ${fam.length} 个指标家族：${fs} 个偏空、${fb} 个偏多，卖盘${fs - fb >= 3 ? "明显" : "略"}占上风`
          : `动量和资金类 ${fam.length} 个指标家族多空各半`;
  } else {
    const s = panel.summary;
    const bull = s.momentum.bull + s.volume.bull + s.pattern.bull;
    const bear = s.momentum.bear + s.volume.bear + s.pattern.bear;
    const cnt = [s.momentum, s.volume, s.pattern].reduce((a, x) => a + x.bull + x.bear + x.neutral, 0);
    momentum = clamp(((bull - bear) / Math.max(1, cnt)) * 150);
    momText =
      bull > bear
        ? `动量和资金类指标 ${bull} 个看多、${bear} 个看空，买盘${bull - bear >= 4 ? "明显" : "略"}占上风`
        : bear > bull
          ? `动量和资金类指标 ${bear} 个看空、${bull} 个看多，卖盘${bear - bull >= 4 ? "明显" : "略"}占上风`
          : `动量和资金类指标多空各半`;
  }

  // ---- position: room to resistance vs distance to support
  const s1 = supports[0], r1 = resistances[0];
  let position = 0;
  let posText = "附近没有明确的支撑或阻力";
  if (s1 && r1) {
    const ds = Math.abs(s1.distancePct), dr = Math.abs(r1.distancePct);
    position = clamp(((dr - ds) / (dr + ds)) * 100);
    posText = `下方支撑 ${fmtPrice(s1.price)}（${pct(s1.distancePct)}），上方阻力 ${fmtPrice(r1.price)}（${pct(r1.distancePct)}）。${ds < dr ? "离支撑更近，下跌空间相对小" : "离阻力更近，上涨空间相对小"}`;
  } else if (s1) {
    position = 30;
    posText = `上方没有明显阻力，下方支撑 ${fmtPrice(s1.price)}（${pct(s1.distancePct)}）`;
  } else if (r1) {
    position = -30;
    posText = `下方没有明显支撑，上方阻力 ${fmtPrice(r1.price)}（${pct(r1.distancePct)}）`;
  }

  const timing = timingScore(td, lastIdx);

  const components: Component[] = [
    { key: "trend", label: "趋势", score: trend.current, text: `${trend.label}。${trend.explain}` },
    { key: "momentum", label: "动量资金", score: Math.round(momentum), text: momText },
    { key: "position", label: "所处位置", score: Math.round(position), text: posText },
    { key: "timing", label: "时机 (TD)", score: timing.score, text: timing.text },
  ];
  const score = Math.round(W.trend * trend.current + W.momentum * momentum + W.position * position + W.timing * timing.score);
  const light: Light = score >= W.threshold ? "green" : score <= -W.threshold ? "red" : "yellow";
  const sign = Math.sign(score);
  const agreement = sign === 0 ? 0 : components.filter((c) => Math.sign(c.score) === sign && Math.abs(c.score) >= 10).length;

  const atrPct = (atr / price) * 100;
  const tfName = TF_LABEL[tf];
  const lightText = light === "green" ? "偏多" : light === "red" ? "偏空" : "观望";

  let headline: string;
  const plan: string[] = [];

  // ---- stop reference: beyond the nearest structural swing point by the sweep buffer
  const risk = args.risk;
  const buffer = risk?.buffer ?? DEFAULT_BUFFER_ATR;
  const stopFor = (side: "long" | "short") => {
    const anchors = side === "long" ? risk?.below ?? [] : risk?.above ?? [];
    const fallback = side === "long" ? s1?.price : r1?.price;
    const anchor = anchors[0] ?? fallback;
    if (anchor == null) return null;
    const sg = side === "long" ? -1 : 1;
    const ref = anchor + sg * buffer * atr;
    const alt = anchors[1] != null ? anchors[1] + sg * buffer * atr : null;
    const k = Math.abs(price - ref) / atr;
    return { ref, anchor, structural: anchors[0] != null, alt, k, noise: noiseProb(risk?.cal ?? null, k) };
  };
  const stopDetail = (st: NonNullable<ReturnType<typeof stopFor>>, side: "long" | "short") => {
    const where = st.structural ? `${side === "long" ? "结构低点" : "结构高点"} ${fmtPrice(st.anchor)}` : `${side === "long" ? "支撑" : "阻力"} ${fmtPrice(st.anchor)}`;
    let t = `它在${where} ${side === "long" ? "下方" : "上方"}留了 ${buffer.toFixed(1)} 倍平均波幅的扫损缓冲，离现价 ${st.k.toFixed(1)} 倍波幅。`;
    if (st.noise != null) {
      t += `正常波动在 ${risk?.horizonText ?? "持有期"}内碰到这个距离的概率约 ${st.noise}%`;
      t += st.noise > 50 ? `，止损偏近，只适合短线小仓位${st.alt != null ? `；更稳的认错位在 ${fmtPrice(st.alt)}` : ""}。` : "。";
    }
    return t;
  };
  let st: ReturnType<typeof stopFor> = null;
  let stopText = "";
  if (light === "green") {
    headline = `${tfName}级别偏多：${trend.label === "震荡" ? "虽然趋势还不明显，但多数信号向好" : `${trend.label}，多数信号同向`}${r1 ? `；上方 ${fmtPrice(r1.price)} 附近可能遇阻` : ""}。`;
    if (s1) plan.push(`不追高：等价格回踩 ${fmtPrice(s1.price)} 附近、不再继续跌破时，再考虑分批买入。`);
    st = stopFor("long");
    if (st) stopText = `跌破 ${fmtPrice(st.ref)}（约 ${pct(((st.ref - price) / price) * 100)}）说明判断错了，应该认错离场。${stopDetail(st, "long")}`;
    if (r1) plan.push(`接近 ${fmtPrice(r1.price)} 时可以考虑先卖一部分锁定利润；放量突破后再看下一个阻力。`);
  } else if (light === "red") {
    headline = `${tfName}级别偏空：${trend.label === "震荡" ? "趋势不明，但多数信号偏弱" : `${trend.label}，多数信号同向`}${s1 ? `；下方 ${fmtPrice(s1.price)} 是第一道支撑` : ""}。`;
    plan.push("下跌途中不要急着抄底，“便宜了”不是买入理由。");
    if (r1) plan.push(`已经持有的话，反弹到 ${fmtPrice(r1.price)} 附近可以考虑减仓。`);
    st = stopFor("short");
    if (st) stopText = `价格重新站上 ${fmtPrice(st.ref)}（约 ${pct(((st.ref - price) / price) * 100)}）才说明空头判断失效。${stopDetail(st, "short")}`;
    plan.push("想抄底的话，至少等价格重新站上短期阻力之后；TD 跌势 9 / 13 只说明跌了很久，不是买点。");
  } else {
    headline = `${tfName}级别方向不明：多空信号互相打架，建议观望。`;
    if (r1 && s1) plan.push(`等价格有效突破 ${fmtPrice(r1.price)}（转强）或跌破 ${fmtPrice(s1.price)}（转弱）后再判断方向。`);
    plan.push("震荡行情里频繁买卖最容易亏手续费和本金，少动就是赚。");
    st = stopFor("long");
    if (st) stopText = `如果一定要做多，认错位可以参考 ${fmtPrice(st.ref)}（约 ${pct(((st.ref - price) / price) * 100)}）。${stopDetail(st, "long")}`;
  }
  const stopRef = st?.ref ?? null;
  plan.push(`这个周期适合的持有时间：${TF_HORIZON[tf]}。每根 K 线平均波动 ${atrPct.toFixed(1)}%，仓位要与之匹配。`);

  if (st) plan.push("止损离得越远，仓位就要越小：先定认错位，再按“每笔最多亏多少”算仓位。");
  return {
    light,
    lightText,
    score,
    agreement,
    headline,
    components,
    plan,
    stopRef,
    stopText,
    stopAnchor: st?.structural ? st.anchor : null,
    stopAtr: st ? Math.round(st.k * 100) / 100 : null,
    stopNoisePct: st?.noise ?? null,
    stopAlt: st?.alt ?? null,
    atrPct,
  };
}
