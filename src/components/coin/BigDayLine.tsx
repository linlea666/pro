"use client";

import { BIGDAY_RULES, bigDayFact, bigDayHeadline, bigDayToday, type BigDay } from "@/lib/ta/bigday";
import type { Mode } from "./CoinView";

/**
 * 昨天是大波动日（E42 D1，实时盯盘页签，放量冲击那一行下面）：昨天振幅 ≥ 之前 20 天中位 2 倍时，今天全天显示。
 * 只描述第二天的历史比例和今天到现在的进展，不是信号。文字全部来自 src/lib/ta/bigday.ts。
 */
export function BigDayLine({ x, mode }: { x: BigDay | null | undefined; mode: Mode }) {
  if (!x) return null;
  const today = bigDayToday(x);
  return (
    <section className="card border-l-4 border-l-warn p-4" aria-label="昨天是大波动日">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 whitespace-nowrap rounded-full border border-warn/60 bg-warn-soft px-2 py-0.5 text-[11px] text-warn">昨天大波动</span>
        <h3 className="text-sm font-semibold">{bigDayHeadline(x).replace(/^昨天是大波动日：/, "")}</h3>
        <span className="text-[11px] text-ink-3">日线按北京 8 点收盘 · 只描述，不是信号</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed">{bigDayFact(x)}</p>
      {today && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{today}</p>}
      {mode === "pro" && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          大波动日 = 振幅至少是之前 {BIGDAY_RULES.base} 天中位的 {BIGDAY_RULES.ratio} 倍；inside day = 第二天没越过前高、也没跌破前低。这些只是历史比例，不是对随机入场的优势（E42 里在关键位扫过前低再收回、快速反弹再进，都没有优势）。
        </p>
      )}
    </section>
  );
}
