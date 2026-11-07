"use client";

import { SQUEEZE_FACTS, squeezeAtr, squeezeHeadline, type Squeeze } from "@/lib/ta/squeeze";
import type { Mode } from "./CoinView";

/**
 * 波动压缩（E46，实时盯盘页签，扫低后的费率和持仓那一行下面）：之前 7 天的波动压到一年最低 10% 以内时全天显示。
 * 写明不是变盘信号，另提醒按 ATR 算的止损和仓位；只描述。文字全部来自 src/lib/ta/squeeze.ts。
 */
export function SqueezeLine({ x, mode }: { x: Squeeze | null | undefined; mode: Mode }) {
  if (!x) return null;
  return (
    <section className="card border-l-4 border-l-warn p-4" aria-label="波动压缩">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 whitespace-nowrap rounded-full border border-warn/60 bg-warn-soft px-2 py-0.5 text-[11px] text-warn">波动压缩</span>
        <h3 className="text-sm font-semibold">{squeezeHeadline(x)}</h3>
        <span className="text-[11px] text-ink-3">不是变盘信号 · 只描述</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed">{SQUEEZE_FACTS.after}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{squeezeAtr(x)}</p>
      {mode === "pro" && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">{SQUEEZE_FACTS.pro}</p>}
    </section>
  );
}
