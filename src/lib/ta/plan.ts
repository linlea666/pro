import type { Candle, Timeframe } from "../types.ts";
import { TF_LABEL } from "../types.ts";
import type { Level } from "./levels.ts";
import { bufferAtr, intactPivots, noiseProb, PIVOT_K, type Calibration } from "./risk.ts";
import { BREAK_ATR, PIERCE_ATR, type StructureState, type Swing } from "./structure.ts";

/**
 * Trading plans: for each side, what kind of trade fits the structure now, what
 * triggers it, where it is wrong, where it may go and how to follow it.
 *
 * The entry rules here are the ones the research framework measures (E12,
 * src/lib/research/plans.ts calls `findEntries`), so the page and the evidence
 * describe the same trades. What the evidence says (local spot history, 2026-10):
 * no entry type beats random timing by a margin we can prove; following new
 * structure points with the stop beat a fixed 2R target in sample (E11); taking
 * profit at +0.5R cost 0.16R (4h) to 1R (daily) per trade (E14); for pullbacks,
 * waiting for a confirming close beat entering in the zone; the higher timeframe's
 * structure was a better filter than its 50 EMA. The defaults below follow that.
 */

export type EntryKind = "breakout" | "pullback" | "pullback_confirm" | "reversal";

export const ENTRY_NAME: Record<EntryKind, string> = {
  breakout: "突破跟随",
  pullback: "顺势回调（进入回调区就入场）",
  pullback_confirm: "顺势回调（等收盘确认再入场）",
  reversal: "逆势反转（结构被打破后入场）",
};

/** Retracement zone of the last leg that counts as a pullback. */
export const PULLBACK_ZONE: [number, number] = [0.382, 0.786];

export interface EntryEvent {
  i: number;
  t: number;
  dir: 1 | -1;
  kind: EntryKind;
  /** the protective swing the stop hangs on */
  anchor: number;
  /** anchor plus the p80 sweep buffer */
  stop: number;
  /** direction of the higher timeframe at the entry bar */
  filter: 1 | -1 | 0;
  /** the anchor sits on equal highs / lows (E9: within 0.1 ATR of another intact swing) */
  equal: boolean;
  /** entry bar volume against the median of the 20 bars before it */
  relVol: number;
}

export interface FindArgs {
  tf: Timeframe;
  c: Candle[];
  atr: number[];
  ss: StructureState[];
  /** higher-timeframe direction known at the close of bar t */
  filterAt: (t: number) => 1 | -1 | 0;
  /** sweep buffer (ATR) for the stop: the calibrated p80 */
  buf: number;
  /** first bar to look at */
  from: number;
}

/**
 * Entry triggers on closed bars, both directions:
 * - breakout: the first close 0.1 ATR beyond the last swing high (low);
 * - pullback: an intact trend whose last leg is done, price back in 38.2–78.6% of it;
 *   "confirm" waits for a close beyond the previous bar's extreme while still in or near the zone;
 * - reversal: the opposite trend's protective swing broken on a close (0.8 ATR), or a
 *   higher low (lower high) followed by a close beyond the last swing.
 * The same kind and direction is not repeated within 6 bars.
 */
export function findEntries(a: FindArgs): EntryEvent[] {
  const { tf, c, atr, ss, filterAt, buf, from } = a;
  const out: EntryEvent[] = [];
  const last = new Map<string, number>();
  const vol = c.map((x) => x.v);
  const add = (i: number, dir: 1 | -1, kind: EntryKind, anchor: number) => {
    const key = `${kind}${dir}`;
    if (i - (last.get(key) ?? -1e9) < 6) return;
    const stop = anchor - dir * buf * atr[i];
    const risk = ((c[i].c - stop) * dir) / atr[i];
    if (!(risk >= 0.3 && risk <= 8)) return;
    last.set(key, i);
    const equal = intactPivots(c, atr, i, PIVOT_K[tf], dir > 0 ? "low" : "high", 300).filter((p) => Math.abs(p.price - anchor) <= 0.1 * atr[i]).length >= 2;
    const med = [...vol.slice(Math.max(0, i - 20), i)].sort((x, y) => x - y)[10] || vol[i];
    out.push({ i, t: c[i].t, dir, kind, anchor, stop, filter: filterAt(i), equal, relVol: vol[i] / med });
  };
  for (let t = Math.max(7, from); t < c.length; t++) {
    const s = ss[t], p = ss[t - 1], A = atr[t];
    if (!s.lastHigh || !s.lastLow || !(A > 0)) continue;
    const close = c[t].c, prev = c[t - 1].c;
    for (const dir of [1, -1] as const) {
      const ext = dir > 0 ? s.lastHigh : s.lastLow;
      const prot = dir > 0 ? s.lastLow : s.lastHigh;
      const lvl = ext.price + dir * PIERCE_ATR * A;
      if ((close - lvl) * dir > 0 && (prev - lvl) * dir <= 0) add(t, dir, "breakout", prot.price);
      const retr = pullbackDepth(s, dir);
      if (retr) {
        const now = retr(close), before = retr(prev);
        if (now >= PULLBACK_ZONE[0] && now <= PULLBACK_ZONE[1] && before < PULLBACK_ZONE[0]) add(t, dir, "pullback", prot.price);
        const inZone = [1, 2, 3, 4, 5, 6].some((k) => {
          const x = retr(c[t - k].c);
          return x >= PULLBACK_ZONE[0] && x <= PULLBACK_ZONE[1];
        });
        const turned = dir > 0 ? close > c[t - 1].h : close < c[t - 1].l;
        if (inZone && turned && now < PULLBACK_ZONE[1] && now > 0) add(t, dir, "pullback_confirm", prot.price);
      }
      const opp = dir > 0 ? "down" : "up";
      const broke = s.state === opp && s.breach === "broken" && p.breach !== "broken";
      const flipped = s.state === "range" && (dir > 0 ? s.lastLow.label === "HL" : s.lastHigh.label === "LH") && s.beyond === dir && p.beyond !== dir;
      if (broke || flipped) add(t, dir, "reversal", prot.price);
    }
  }
  return out;
}

/** For an intact trend in `dir` whose last leg is complete: how deep a price is into that leg (0 = at its end). */
function pullbackDepth(s: StructureState, dir: 1 | -1): ((price: number) => number) | null {
  if (!s.lastHigh || !s.lastLow) return null;
  const trend = dir > 0 ? "up" : "down";
  const legDone = dir > 0 ? s.lastHigh.i > s.lastLow.i : s.lastLow.i > s.lastHigh.i;
  if (s.state !== trend || s.breach !== "none" || !legDone) return null;
  const ext = dir > 0 ? s.lastHigh.price : s.lastLow.price;
  const span = Math.abs(s.lastHigh.price - s.lastLow.price);
  return (price) => (span > 0 ? ((ext - price) * dir) / span : 0);
}

/**
 * The stop as the plan would have it now for a trade opened at bar `entry`:
 * moved behind each swing confirmed since (in the trade's direction), never loosened.
 */
export function trailingStop(c: Candle[], atr: number[], sw: Swing[], buf: number, entry: number, dir: 1 | -1, stop0: number): number {
  let stop = stop0;
  for (const s of sw) {
    if (s.confirmedAt <= entry || s.kind !== (dir > 0 ? "low" : "high")) continue;
    const level = s.price - dir * buf * atr[s.confirmedAt];
    if ((level - stop) * dir > 0 && (c[s.confirmedAt].c - level) * dir > 0) stop = level;
  }
  return stop;
}

// ---------------------------------------------------------------- the plan for the page

export interface PlanEvidence {
  /** research row this plan type is measured by */
  key: string;
  n: number;
  hit: number | null;
  meanR: number | null;
  /** against random timing with the same stop and exits */
  edgeR: number | null;
  oosEdgeR: number | null;
  oosN: number;
  verdict: string;
}

export interface SidePlan {
  side: "long" | "short";
  kind: EntryKind | null;
  /** active: triggered on one of the last closed bars and still valid; watch: waiting for the trigger */
  status: "active" | "watch" | "none";
  /** against the higher timeframe's direction */
  alignment: "with" | "against" | "neutral";
  headline: string;
  trigger: string;
  entry: number | null;
  /** price range to wait for (pullbacks) */
  zone: [number, number] | null;
  invalidation: {
    anchor: number;
    /** p50 … p90 of the sweep depth beyond the anchor */
    zone: [number, number];
    /** p80: the stop the plan uses */
    stop: number;
    equal: boolean;
    distPct: number;
    distAtr: number;
    /** chance plain noise touches the stop within the calibrated horizon, % */
    noise: number | null;
  } | null;
  targets: { price: number; label: string; rr: number }[];
  size: "full" | "half";
  /** how to follow the trade once in it */
  trailing: string;
  /** costs (round trip and funding over a typical hold) as a share of the risk */
  costR: number | null;
  warnings: string[];
  /** filled in by the caller from the latest research report */
  evidence: PlanEvidence | null;
  /** other triggers worth watching on this side */
  alternatives: string[];
}

export interface PlanInput {
  tf: Timeframe;
  filterTf: Timeframe;
  c: Candle[];
  atr: number[];
  ss: StructureState[];
  sw: Swing[];
  /** higher-timeframe direction at each entry-timeframe bar (for recent triggers) */
  filterAt: (t: number) => 1 | -1 | 0;
  cal: Calibration | null;
  /** clustered key levels around the price, for targets */
  levels: Level[];
  /** latest traded price (the bar still forming) */
  livePrice: number;
  costPct: number;
  funding: { rate: number; intervalH: number } | null;
}

const fmt = (p: number) => (p >= 1000 ? Math.round(p).toLocaleString("en-US") : p >= 1 ? p.toFixed(2) : p.toPrecision(4));
/** typical hold of a trade followed with the structure stop, in bars (E11, 4h ≈ 5 days) */
const TYPICAL_HOLD_BARS: Partial<Record<Timeframe, number>> = { "4h": 30, "1d": 16 };

export function buildPlans(inp: PlanInput): { long: SidePlan; short: SidePlan; buffers: { p50: number; p80: number; p90: number } } {
  const { tf, filterTf, c, atr, ss, cal } = inp;
  const n = c.length - 1;
  const buffers = { p50: bufferAtr(cal, 50), p80: bufferAtr(cal, 80), p90: bufferAtr(cal, 90) };
  const recent = findEntries({ tf, c, atr, ss, filterAt: inp.filterAt, buf: buffers.p80, from: n - 2 });
  return { long: side(1), short: side(-1), buffers };

  function side(dir: 1 | -1): SidePlan {
    const s = ss[n];
    const A = atr[n];
    const word = dir > 0 ? "做多" : "做空";
    const TF = TF_LABEL[tf], FTF = TF_LABEL[filterTf];
    const fdir = inp.filterAt(n);
    const alignment: SidePlan["alignment"] = fdir === dir ? "with" : fdir === -dir ? "against" : "neutral";
    const empty: SidePlan = {
      side: dir > 0 ? "long" : "short",
      kind: null,
      status: "none",
      alignment,
      headline: `${word}：结构还不清楚，先观望`,
      trigger: "",
      entry: null,
      zone: null,
      invalidation: null,
      targets: [],
      size: "full",
      trailing: "",
      costR: null,
      warnings: [],
      evidence: null,
      alternatives: [],
    };
    if (!s?.lastHigh || !s.lastLow || !(A > 0)) return empty;
    const ext = dir > 0 ? s.lastHigh : s.lastLow;
    const prot = dir > 0 ? s.lastLow : s.lastHigh;
    const live = inp.livePrice;

    // candidates, best first
    type Cand = { kind: EntryKind; status: "active" | "watch"; entry: number; zone: [number, number] | null; anchor: number; trigger: string; stop?: number; equal?: boolean; relVol?: number };
    const cands: Cand[] = [];
    const ev = recent.filter((e) => e.dir === dir).pop();
    if (ev) {
      const risk = (c[ev.i].c - ev.stop) * dir;
      // still valid: not stopped and not already run more than half the risk
      if ((live - ev.stop) * dir > 0 && (live - c[ev.i].c) * dir < 0.5 * risk) {
        cands.push({
          kind: ev.kind,
          status: "active",
          entry: c[ev.i].c,
          zone: null,
          anchor: ev.anchor,
          stop: ev.stop,
          equal: ev.equal,
          relVol: ev.relVol,
          trigger: `已在 ${TF} ${new Date(c[ev.i].t * 1000).toISOString().slice(5, 16).replace("T", " ")} 收盘触发（${fmt(c[ev.i].c)}）`,
        });
      }
    }
    const depth = pullbackDepth(s, dir);
    if (depth) {
      const span = Math.abs(s.lastHigh.price - s.lastLow.price);
      const z1 = ext.price - dir * PULLBACK_ZONE[0] * span, z2 = ext.price - dir * PULLBACK_ZONE[1] * span;
      const zone: [number, number] = [Math.min(z1, z2), Math.max(z1, z2)];
      const d = depth(live);
      const confirm = dir > 0 ? `收盘高于前一根最高价 ${fmt(c[n].h)}` : `收盘低于前一根最低价 ${fmt(c[n].l)}`;
      // deeper than 79% of the leg the stop is too close to the price for a pullback trade
      if (d <= PULLBACK_ZONE[1]) {
        cands.push({
          kind: "pullback_confirm",
          status: "watch",
          entry: (zone[0] + zone[1]) / 2,
          zone,
          anchor: prot.price,
          trigger:
            d >= PULLBACK_ZONE[0]
              ? `已在回调区 ${fmt(zone[0])}–${fmt(zone[1])}，等一根 ${TF} K 线${confirm}`
              : `等回调到 ${fmt(zone[0])}–${fmt(zone[1])}（上一段的 38–79%），再等一根 ${TF} K 线收盘确认`,
        });
      }
    }
    if (s.beyond !== dir) {
      const lvl = ext.price + dir * PIERCE_ATR * A;
      cands.push({ kind: "breakout", status: "watch", entry: lvl, zone: null, anchor: prot.price, trigger: `${TF} 收盘${dir > 0 ? "站上" : "跌破"} ${fmt(lvl)}（前${dir > 0 ? "高" : "低"} ${fmt(ext.price)} 外 0.1 倍 ATR）时触发` });
    }
    const opp = dir > 0 ? "down" : "up";
    if (s.state === opp && s.breach !== "broken") {
      const p2 = dir > 0 ? s.lastHigh : s.lastLow; // the opposite trend's protective swing
      const lvl = p2.price + dir * BREAK_ATR * A;
      cands.push({ kind: "reversal", status: "watch", entry: lvl, zone: null, anchor: dir > 0 ? s.lastLow.price : s.lastHigh.price, trigger: `${TF} 收盘${dir > 0 ? "站上" : "跌破"} ${fmt(lvl)}（${dir > 0 ? "下降" : "上升"}结构的保护位 ${fmt(p2.price)} 外 0.8 倍 ATR）时触发` });
    }
    const rank = (x: Cand) =>
      x.status === "active" ? 0 : x.kind === "pullback_confirm" && alignment === "with" ? 1 : x.kind === "breakout" && alignment !== "against" ? 2 : x.kind === "reversal" ? 3 : 4;
    const stopOf = (x: Cand) => x.stop ?? x.anchor - dir * buffers.p80 * A;
    const valid = cands.filter((x) => (x.entry - stopOf(x)) * dir > 0);
    valid.sort((x, y) => rank(x) - rank(y));
    const best = valid[0];
    if (!best) return { ...empty, headline: `${word}：现在没有合适的结构位置，先观望`, alternatives: cands.map((x) => x.trigger) };

    const stop = stopOf(best);
    const risk = (best.entry - stop) * dir;
    const izone: [number, number] = [best.anchor - dir * buffers.p50 * A, best.anchor - dir * buffers.p90 * A];
    const equal =
      best.equal ?? intactPivots(c, atr, n, PIVOT_K[tf], dir > 0 ? "low" : "high", 300).filter((p) => Math.abs(p.price - best.anchor) <= 0.1 * A).length >= 2;
    const targets = inp.levels
      .map((l) => ({ price: l.price, label: l.methods.slice(0, 2).join(" + ") || "关键位" }))
      .concat((ext.price - best.entry) * dir > 0 ? [{ price: ext.price, label: `前${dir > 0 ? "高" : "低"}` }] : [])
      .filter((x) => (x.price - best.entry) * dir > 0.3 * A)
      .sort((x, y) => (x.price - y.price) * dir)
      .filter((x, k, arr) => k === 0 || Math.abs(x.price - arr[k - 1].price) > 0.3 * A)
      .slice(0, 3)
      .map((x) => ({ ...x, rr: Math.round(((x.price - best.entry) * dir * 10) / risk) / 10 }));
    const size: SidePlan["size"] = best.kind === "reversal" || alignment === "against" ? "half" : "full";
    const hold = TYPICAL_HOLD_BARS[tf] ?? 30;
    const holdH = (hold * (tf === "1d" ? 24 : 4));
    const pays = inp.funding && (dir > 0 ? inp.funding.rate > 0 : inp.funding.rate < 0);
    const fundingPx = pays ? Math.abs(inp.funding!.rate) * (holdH / Math.max(1, inp.funding!.intervalH)) * best.entry : 0;
    const costR = Math.round((((inp.costPct / 100) * best.entry + fundingPx) / risk) * 100) / 100;
    const warnings: string[] = [];
    if (alignment === "against") warnings.push(`逆着${FTF}的方向：历史上逆大周期的单子平均更差，建议半仓、目标看近一点`);
    if (best.kind === "reversal") warnings.push("逆势反转是在猜拐点：只用半仓，认错位一破就走");
    if (equal) warnings.push("认错位挂在等高 / 等低点上：这类位置历史上更容易被直接打穿（E9），可以放到下一个结构位之外，或者再缩小仓位");
    if (targets[0] && targets[0].rr < 1.5) warnings.push(`第一个目标的盈亏比只有 1:${targets[0].rr}，不划算`);
    if (costR > 0.2) warnings.push(`成本（手续费、滑点和持仓期资金费）约占一份风险的 ${Math.round(costR * 100)}%`);
    if (risk / A > 3) warnings.push(`认错位离入场 ${(risk / A).toFixed(1)} 倍 ATR，比较远：仓位要相应缩小`);
    if (best.kind === "breakout" && best.relVol != null && tf !== "1h") {
      if (best.relVol >= 2) warnings.push(`放量突破（成交量是最近 20 根中位数的 ${best.relVol.toFixed(1)} 倍）：4 小时及以上的放量突破历史上延续性更好（E9）`);
      else if (best.relVol < 1) warnings.push("缩量突破：历史上延续性差（E9）");
    }
    const kindWord = best.kind === "pullback_confirm" || best.kind === "pullback" ? "顺势回调" : best.kind === "breakout" ? "突破跟随" : "逆势反转";
    return {
      side: dir > 0 ? "long" : "short",
      kind: best.kind,
      status: best.status,
      alignment,
      headline: `${best.status === "active" ? "已触发：" : ""}${kindWord}${word}${size === "half" ? "（半仓）" : ""}`,
      trigger: best.trigger,
      entry: best.entry,
      zone: best.zone,
      invalidation: {
        anchor: best.anchor,
        zone: [Math.min(...izone), Math.max(...izone)],
        stop,
        equal,
        distPct: Math.round((risk / best.entry) * 10000) / 100,
        distAtr: Math.round((risk / A) * 10) / 10,
        noise: noiseProb(cal, risk / A),
      },
      targets,
      size,
      trailing: `入场后，${TF}每确认一个新的${dir > 0 ? "更高低点" : "更低高点"}，就把认错位移到它${dir > 0 ? "下方" : "上方"} ${buffers.p80.toFixed(2)} 倍 ATR；只收紧、不放松，不设固定止盈`,
      costR,
      warnings,
      evidence: null,
      alternatives: valid.slice(1).map((x) => x.trigger),
    };
  }
}

// ---------------------------------------------------------------- sizing

/** Maintenance margin rate assumed for the liquidation estimate (Binance's lowest tier is 0.4%). */
export const MMR = 0.005;

/**
 * Position size from the risk budget, and where an isolated-margin position at
 * `leverage` would be liquidated (ignoring fees and funding). The stop must sit
 * before the liquidation price, or the exchange closes the trade first.
 */
export function sizePosition(o: { capital: number; riskPct: number; entry: number; stop: number; leverage: number }) {
  const dir = o.stop < o.entry ? 1 : -1;
  const riskPerUnit = Math.abs(o.entry - o.stop);
  const qty = riskPerUnit > 0 ? (o.capital * o.riskPct) / 100 / riskPerUnit : 0;
  const notional = qty * o.entry;
  const margin = o.leverage > 0 ? notional / o.leverage : notional;
  const liq = o.leverage > 1 ? o.entry * (1 - dir * (1 / o.leverage - MMR)) : null;
  const stopBeforeLiq = liq == null || (o.stop - liq) * dir > 0;
  return { dir, qty, notional, margin, liq, stopBeforeLiq, effectiveLeverage: o.capital > 0 ? notional / o.capital : 0 };
}
