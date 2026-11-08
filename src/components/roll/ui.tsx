"use client";

import type { HoldingView } from "@/lib/rollbook";
import { ROLL_RULES, type AddLimit, type Tone } from "@/lib/ta/roll";

/** Shared bits of the 滚仓助手 page. */

export const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";
export const money = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
export const toneColor = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink-3");
export const TONE_BG: Record<Tone, string> = { good: "bg-up-soft", wait: "bg-panel-2", warn: "bg-warn-soft", bad: "bg-down-soft" };
export const TONE_TEXT: Record<Tone, string> = { good: "text-up", wait: "text-ink-3", warn: "text-warn", bad: "text-down" };

/** Most urgent first: liquidation / stop problems, then warnings, then the rest. */
export const severity = (v: HoldingView) => (v.status?.tone === "bad" ? 0 : v.status?.tone === "warn" ? 1 : v.status?.tone === "wait" ? 3 : 2);

export function Kpi({ k, v, sub }: { k: React.ReactNode; v: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-line px-3 py-2">
      <div className="text-xs text-ink-3">{k}</div>
      <div className="num truncate text-[17px] font-semibold">{v}</div>
      {sub && <div className="num truncate text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

/** Distance to liquidation in ATR: red under 2, amber under 5, green beyond (the marker caps at 10). */
export function SafetyBar({ atr }: { atr: number }) {
  const at = Math.min(10, atr) * 10;
  return (
    <div className="relative h-2 rounded-full" style={{ background: "linear-gradient(90deg, var(--down) 0 20%, var(--warn) 20% 50%, var(--up) 50% 100%)" }} aria-label={`离强平 ${atr.toFixed(1)} 倍 ATR`}>
      <i className="absolute -top-1 h-4 w-[3px] rounded bg-ink" style={{ left: `calc(${at}% - 1.5px)` }} />
    </div>
  );
}

/** Which rule limits an add, in words. */
export const bindingText = (b: AddLimit["binding"], r: { pyramid: number; maxAdds: number; liqGapAtr: number } = ROLL_RULES) =>
  ({
    budget: "风险预算",
    pyramid: `金字塔（不超过上一笔的 ${r.pyramid * 100}%）`,
    liquidation: `强平距离（止损要在强平前 ${r.liqGapAtr} 倍 ATR）`,
    margin: "可用保证金不够",
    house: "浮盈不够（逐仓激进只用浮盈加）",
    count: `最多加 ${r.maxAdds} 次`,
    losing: "浮亏中不加仓",
    stop: "止损在现价另一边",
  })[b];
