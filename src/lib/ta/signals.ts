import type { EngineParams } from "../params.ts";
import type { Candle } from "../types.ts";
import * as ta from "./core.ts";
import type { computeIndicators } from "./indicators.ts";
import type { TdEvent, TdState } from "./td.ts";

/**
 * The signal registry: every signal whose track record the product shows,
 * as the bar indices where it fired. The live page and the research framework
 * both use this, so a rule is defined once.
 */

export interface SignalEvents {
  key: string;
  name: string;
  side: "bull" | "bear";
  idx: number[];
}

function crossUps(a: number[], b: number[]) {
  const out: number[] = [];
  for (let i = 1; i < a.length; i++) if (a[i] > b[i] && a[i - 1] <= b[i - 1]) out.push(i);
  return out;
}

export function signalEvents(c: Candle[], panel: ReturnType<typeof computeIndicators>, td: TdState, ep: EngineParams): SignalEvents[] {
  const close = ta.closes(c);
  const { rsiLow, rsiHigh } = ep.indicators;
  const ev = (side: "buy" | "sell", kind: TdEvent["kind"]) => td.events.filter((e) => e.side === side && e.kind === kind).map((e) => e.i);
  const e12 = ta.ema(close, 12), e26 = ta.ema(close, 26);
  const r = ta.rsi(close);
  const rsiIn = (below: boolean) => {
    const out: number[] = [];
    for (let i = 1; i < r.length; i++) {
      if (below ? r[i] < rsiLow && r[i - 1] >= rsiLow : r[i] > rsiHigh && r[i - 1] <= rsiHigh) out.push(i);
    }
    return out;
  };
  const strong = Math.max(1, Math.round((panel.readings.length * ep.indicators.strongPct) / 100));
  const S = ep.td.setupLength, CD = ep.td.countdownLength;
  const resoBull: number[] = [], resoBear: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (panel.net[i] >= strong && panel.net[i - 1] < strong) resoBull.push(i);
    if (panel.net[i] <= -strong && panel.net[i - 1] > -strong) resoBear.push(i);
  }
  return [
    { key: "td_buy9", name: `TD 跌势 ${S}`, side: "bull", idx: ev("buy", "setup9") },
    { key: "td_buy13", name: `TD 跌势 ${CD}`, side: "bull", idx: ev("buy", "countdown13") },
    { key: "td_sell9", name: `TD 涨势 ${S}`, side: "bear", idx: ev("sell", "setup9") },
    { key: "td_sell13", name: `TD 涨势 ${CD}`, side: "bear", idx: ev("sell", "countdown13") },
    { key: "ema_golden", name: "EMA 金叉", side: "bull", idx: crossUps(e12, e26) },
    { key: "ema_death", name: "EMA 死叉", side: "bear", idx: crossUps(e26, e12) },
    { key: "rsi_oversold", name: "RSI 进入超卖", side: "bull", idx: rsiIn(true) },
    { key: "rsi_overbought", name: "RSI 进入超买", side: "bear", idx: rsiIn(false) },
    { key: "reso_bull", name: `多指标共振看多（≥${strong}）`, side: "bull", idx: resoBull },
    { key: "reso_bear", name: `多指标共振看空（≥${strong}）`, side: "bear", idx: resoBear },
  ];
}

/** Each indicator's own flips: bars where it turned bullish / bearish. */
export function indicatorFlips(panel: ReturnType<typeof computeIndicators>): { id: string; up: number[]; down: number[] }[] {
  const out: { id: string; up: number[]; down: number[] }[] = [];
  for (const [id, bias] of panel.byId) {
    const up: number[] = [], down: number[] = [];
    for (let i = 1; i < bias.length; i++) {
      if (bias[i] === 1 && bias[i - 1] !== 1) up.push(i);
      if (bias[i] === -1 && bias[i - 1] !== -1) down.push(i);
    }
    out.push({ id, up, down });
  }
  return out;
}
