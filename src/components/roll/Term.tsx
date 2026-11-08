"use client";

import { useState } from "react";

/** One plain sentence for each word a beginner trips over. */
export const GLOSSARY = {
  ATR: "平均真实波幅：这个周期一根 K 线平常上下波动多少。“1 倍 ATR”就是正常走一根的幅度，用来衡量远近。",
  R: "一笔交易一开始准备亏的钱（入场到止损的距离 × 数量）。+2R 就是赚了两倍于准备亏的钱。",
  结构认错位: "最近一个摆动低点（空单是高点）再往外加一点扫损缓冲。价格收在它外面，说明这段走势的判断错了。",
  爆仓安全倍数: "账户权益 ÷ 维持保证金。降到 1 倍交易所就会强平；3 倍以下要小心，1.5 倍以下要立刻减仓或补保证金。",
  强平: "亏到保证金只剩维持保证金时，交易所会强行平仓，剩下的保证金基本拿不回来。",
  站稳: "收盘价留在关键位外面。只是盘中碰到、收盘又回来，叫“没站稳”。",
  保本滚: "先把止损移到开仓价附近（打到不亏），再用浮盈加仓。",
  关键位: "币页上多种方法合并出来的支撑 / 压力位，是价格可能停顿的地方，不是一定会到的目标。",
  逐仓: "这笔仓位只用自己的保证金，最多亏掉放进去的那部分，不连累账户其他钱。",
  全仓: "账户里的钱一起给所有全仓仓位做担保：一笔亏得多，会把其他全仓仓位的强平价一起拉近。",
} as const;

/** A term with a dotted underline; hover or tap shows one plain sentence. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button type="button" className="cursor-help underline decoration-dotted underline-offset-2" title={GLOSSARY[k]} onClick={() => setOpen((x) => !x)}>
        {children ?? k}
      </button>
      {open && (
        <span role="note" className="absolute left-0 top-full z-20 mt-1 block w-64 rounded-lg border border-line bg-panel p-2 text-xs font-normal leading-relaxed text-ink-2 shadow-lg" onClick={() => setOpen(false)}>
          {GLOSSARY[k]}
        </span>
      )}
    </span>
  );
}
