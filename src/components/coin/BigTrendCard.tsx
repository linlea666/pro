"use client";

import { bigTrendLine, bigTrendRows, type BigTrend, type TfTrend } from "@/lib/ta/bigtrend";

/**
 * 大趋势卡（盯盘、趋势与计划、裸 K 页签顶部）：日线在前（顺逆按日线算，同计划页），周线在后只当背景（加周线阶段）。
 * 只按收盘的周线 / 日线变，盘中不抖；只描述，不改任何规则（E37：逆大趋势并不可证明地更差）。
 * 文字来自 src/lib/ta/bigtrend.ts，这里只排版。
 */

const DIR = {
  1: { word: "向上", cls: "border-up/60 bg-up-soft text-up" },
  [-1]: { word: "向下", cls: "border-down/60 bg-down-soft text-down" },
  0: { word: "不明", cls: "border-line bg-panel-2 text-ink-2" },
} as const;

function Row({ x, text }: { x: TfTrend; text: string }) {
  const d = DIR[x.dir];
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-0.5 shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${d.cls}`}>
        {x.tf === "1w" ? "周线" : "日线"} {d.word}
      </span>
      <span className="min-w-0 text-[13px] leading-relaxed text-ink-2">{text}</span>
    </li>
  );
}

export function BigTrendCard({ big }: { big: BigTrend | null | undefined }) {
  if (!big) return null;
  const [day, week] = bigTrendRows(big);
  return (
    <section className="card p-4" aria-label="大趋势">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold">大趋势</h3>
        <span className="text-[13px] text-ink-2">{bigTrendLine(big)}</span>
        <span className="text-[11px] text-ink-3">只按收盘的周线、日线变 · 只描述，不预测</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        <Row x={big.day} text={day} />
        <Row x={big.week} text={week} />
      </ul>
    </section>
  );
}
