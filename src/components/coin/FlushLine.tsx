"use client";

import { FLUSH_RULE_TEXT, flushBase, flushFact, flushHeadline, flushNow, flushNumbers, type Flush } from "@/lib/ta/flush";
import type { Mode } from "./CoinView";
import { fmtBjTime } from "./format";

/**
 * 扫低后的合约状态（E43，实时盯盘页签，大波动日那一行下面）：1 小时扫过 7 天低点之后 24 小时内显示那根收盘时的
 * 资金费率、持仓量和这种状态的历史比例。只描述，不是信号。文字全部来自 src/lib/ta/flush.ts。
 */
export function FlushLine({ x, mode }: { x: Flush | null | undefined; mode: Mode }) {
  if (!x) return null;
  const now = mode === "pro" ? flushNow(x) : null;
  return (
    <section className="card border-l-4 border-l-accent p-4" aria-label="扫低后的合约状态">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 whitespace-nowrap rounded-full border border-accent/50 bg-accent-soft px-2 py-0.5 text-[11px] text-accent">扫低后的费率和持仓</span>
        <h3 className="text-sm font-semibold">{flushHeadline(x)}</h3>
        <span className="text-[11px] text-ink-3">{fmtBjTime(x.t + 3600)} 收盘 · 只描述，不是信号</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{flushNumbers(x)}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed">{flushFact(x)}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{flushBase(x)}</p>
      {now && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{now}</p>}
      {mode === "pro" && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">{FLUSH_RULE_TEXT}</p>}
    </section>
  );
}
