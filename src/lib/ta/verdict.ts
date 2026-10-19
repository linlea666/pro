import type { Timeframe } from "../types.ts";
import { TF_HORIZON, TF_LABEL } from "../types.ts";
import type { IndicatorPanel } from "./indicators.ts";
import type { Level } from "./levels.ts";
import type { TdState } from "./td.ts";
import type { TrendResult } from "./trend.ts";

/**
 * The traffic light: one composite score per symbol/timeframe, translated
 * into plain language with a risk reference. Weights:
 * trend 40% · momentum & flow 25% · position vs levels 20% · TD timing 15%.
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
  confidence: "高" | "中" | "低";
  headline: string;
  components: Component[];
  plan: string[];
  stopRef: number | null;
  stopText: string;
  atrPct: number;
}

const W = { trend: 0.4, momentum: 0.25, position: 0.2, timing: 0.15 };
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
      const name = ev.side === "buy" ? (ev.kind === "countdown13" ? "买入13（下跌衰竭）" : "买入9（下跌可能歇脚）") : ev.kind === "countdown13" ? "卖出13（上涨衰竭）" : "卖出9（上涨可能歇脚）";
      return { score: base * dir, text: `${age === 0 ? "本根" : `${age} 根前`}出现 TD ${name}，${dir > 0 ? "短期有反弹可能" : "短期有回调可能"}` };
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
}): Verdict {
  const { tf, price, atr, trend, panel, td, supports, resistances, lastIdx } = args;

  // ---- momentum & flow: momentum, volume, pattern categories
  const s = panel.summary;
  const bull = s.momentum.bull + s.volume.bull + s.pattern.bull;
  const bear = s.momentum.bear + s.volume.bear + s.pattern.bear;
  const cnt = [s.momentum, s.volume, s.pattern].reduce((a, x) => a + x.bull + x.bear + x.neutral, 0);
  const momentum = clamp(((bull - bear) / Math.max(1, cnt)) * 150);
  const momText =
    bull > bear
      ? `动量和资金类指标 ${bull} 个看多、${bear} 个看空，买盘${bull - bear >= 4 ? "明显" : "略"}占上风`
      : bear > bull
        ? `动量和资金类指标 ${bear} 个看空、${bull} 个看多，卖盘${bear - bull >= 4 ? "明显" : "略"}占上风`
        : `动量和资金类指标多空各半`;

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
  const light: Light = score >= 18 ? "green" : score <= -18 ? "red" : "yellow";
  const sign = Math.sign(score);
  const agree = components.filter((c) => Math.sign(c.score) === sign && Math.abs(c.score) >= 10).length;
  const confidence: Verdict["confidence"] = Math.abs(score) >= 35 && agree >= 3 ? "高" : Math.abs(score) >= 18 && agree >= 2 ? "中" : "低";

  const atrPct = (atr / price) * 100;
  const tfName = TF_LABEL[tf];
  const lightText = light === "green" ? "偏多" : light === "red" ? "偏空" : "观望";

  let headline: string;
  const plan: string[] = [];
  let stopRef: number | null = null;
  let stopText = "";
  if (light === "green") {
    headline = `${tfName}级别偏多：${trend.label === "震荡" ? "虽然趋势还不明显，但多数信号向好" : `${trend.label}，多数信号同向`}${r1 ? `；上方 ${fmtPrice(r1.price)} 附近可能遇阻` : ""}。`;
    if (s1) {
      stopRef = s1.price - 0.5 * atr;
      plan.push(`不追高：等价格回踩 ${fmtPrice(s1.price)} 附近、不再继续跌破时，再考虑分批买入。`);
      stopText = `跌破 ${fmtPrice(stopRef)}（约 ${pct(((stopRef - price) / price) * 100)}）说明判断错了，应该认错离场。`;
    }
    if (r1) plan.push(`接近 ${fmtPrice(r1.price)} 时可以考虑先卖一部分锁定利润；放量突破后再看下一个阻力。`);
  } else if (light === "red") {
    headline = `${tfName}级别偏空：${trend.label === "震荡" ? "趋势不明，但多数信号偏弱" : `${trend.label}，多数信号同向`}${s1 ? `；下方 ${fmtPrice(s1.price)} 是第一道支撑` : ""}。`;
    plan.push("下跌途中不要急着抄底，“便宜了”不是买入理由。");
    if (r1) {
      stopRef = r1.price + 0.5 * atr;
      plan.push(`已经持有的话，反弹到 ${fmtPrice(r1.price)} 附近可以考虑减仓。`);
      stopText = `价格重新站上 ${fmtPrice(stopRef)}（约 ${pct(((stopRef - price) / price) * 100)}）才说明空头判断失效。`;
    }
    plan.push("想抄底的话，至少等出现 TD 买入 9/13，或价格重新站上短期阻力之后。");
  } else {
    headline = `${tfName}级别方向不明：多空信号互相打架，建议观望。`;
    if (r1 && s1) plan.push(`等价格有效突破 ${fmtPrice(r1.price)}（转强）或跌破 ${fmtPrice(s1.price)}（转弱）后再判断方向。`);
    plan.push("震荡行情里频繁买卖最容易亏手续费和本金，少动就是赚。");
    if (s1) {
      stopRef = s1.price - 0.5 * atr;
      stopText = `如果一定要参与，止损可以参考 ${fmtPrice(stopRef)}（约 ${pct(((stopRef - price) / price) * 100)}）。`;
    }
  }
  plan.push(`这个周期适合的持有时间：${TF_HORIZON[tf]}。每根 K 线平均波动 ${atrPct.toFixed(1)}%，仓位要与之匹配。`);

  return { light, lightText, score, confidence, headline, components, plan, stopRef, stopText, atrPct };
}
