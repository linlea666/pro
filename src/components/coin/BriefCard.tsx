"use client";

import { useMemo } from "react";
import type { TrendPlan } from "@/lib/trendplan";
import type { BriefNumber, BriefTone } from "@/lib/ta/brief";
import { PriceChart, type Band, type PriceLineSpec } from "../PriceChart";
import { fmtBjTime, fmtPrice } from "./format";

/**
 * 行情导视卡（总览顶部）：一句话 → 几个关键数字 → 4 小时价位图（带这段的区间色带）→ 各周期一格 → 接下来看什么。
 * 内容全部来自服务端 `TrendPlan.brief`（src/lib/ta/brief.ts，只组装已有模块），这里只排版。
 */

const TF_WORD = { "1h": "1 小时", "4h": "4 小时", "1d": "日线", "1w": "周线" } as const;

/** chart colours (the chart needs real colours, not CSS variables) */
const LINE = { above: "#e66767", below: "#199e70", flip: "#9085e9", core: "#3987e5" } as const;
const BAND_FILL = "rgba(57, 135, 229, 0.10)";

const numColor = (v: BriefNumber) => (v.key === "core" ? "var(--accent)" : v.side === "flip" ? "#9085e9" : v.side === "above" ? "var(--down)" : "var(--up)");
const toneBar: Record<BriefTone, string> = { up: "bg-up", down: "bg-down", neutral: "bg-ink-3" };
const toneTag: Record<BriefTone, string> = { up: "bg-up-soft text-up", down: "bg-down-soft text-down", neutral: "bg-panel-2 text-ink-2" };
const toneIcon: Record<BriefTone, string> = { up: "▲", down: "▼", neutral: "●" };

/** the same rounding as the sentences (whole dollars above 1,000), so a number reads the same everywhere on the card */
const fmtNum = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString("en-US") : fmtPrice(v));

/** 4 小时 K 线画多少根：约 11 天 */
const CHART_BARS = 66;

export function BriefCard({ p, onTab }: { p: TrendPlan; onTab: (t: string) => void }) {
  const b = p.brief;
  const candles = useMemo(() => p.candles.slice(-(CHART_BARS + (p.forming ? 1 : 0))), [p.candles, p.forming]);
  const priceLines = useMemo<PriceLineSpec[]>(
    () => (b?.numbers ?? []).map((v) => ({ price: v.price, color: v.key === "core" ? LINE.core : LINE[v.side], title: v.label, dashed: v.key !== "core" && v.key !== "flip", width: v.key === "core" ? 2 : 1 })),
    [b],
  );
  const bands = useMemo<Band[]>(() => (b?.band ? [{ lo: b.band.lo, hi: b.band.hi, color: BAND_FILL }] : []), [b]);
  if (!b) return null;

  return (
    <section className="card overflow-hidden" aria-label="行情导视">
      {/* ① 一句话 */}
      <div className="border-b border-line p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          <span className="font-medium text-ink-2">{p.coin} 行情导视</span>
          <span>按 {fmtBjTime(b.t + 4 * 3600)} 收盘的 4 小时 K 线（北京时间）</span>
          <span className="ml-auto">只描述，不预测</span>
        </div>
        <h2 className="mt-1.5 text-xl font-semibold leading-snug">{b.title}</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-accent">{b.line}</p>
      </div>

      {/* ② 关键数字（从高到低） */}
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        {b.numbers.map((v) => (
          <div key={v.key} className="bg-panel p-3" title={v.note}>
            <div className="text-[12px] text-ink-3">{v.label}</div>
            <div className="num mt-0.5 text-xl font-semibold" style={{ color: numColor(v) }}>
              {fmtNum(v.price)}
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{v.note}</div>
          </div>
        ))}
      </div>

      {/* ③ 价位地图 */}
      <div className="border-t border-line p-3">
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-ink-3">
          <span className="font-medium text-ink-2">价位地图</span>
          <span>4 小时 K 线 · 近 11 天</span>
          {b.band && (
            <span>
              <span className="mr-1 inline-block h-2.5 w-3 rounded-sm align-middle" style={{ background: BAND_FILL, outline: "1px solid rgba(57,135,229,0.35)" }} />
              浅色带：{b.band.label}
            </span>
          )}
        </div>
        <PriceChart candles={candles} priceLines={priceLines} bands={bands} height={260} showVolume={false} initialBars={CHART_BARS} />
      </div>

      {/* ④ 各周期一格 */}
      <div className="border-t border-line p-4">
        <h3 className="mb-2 text-sm font-semibold">各周期在哪一格</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {b.cells.map((c) => (
            <div key={c.tf} className="overflow-hidden rounded-lg border border-line bg-panel">
              <div className={`h-1 ${toneBar[c.tone]}`} />
              <div className="p-2.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[13px] font-medium">{TF_WORD[c.tf]}</span>
                  <span className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] ${toneTag[c.tone]}`}>{c.name}</span>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-ink-2">{c.text}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-ink-3">1 小时、4 小时按行情阶段（同实时盯盘的阶段卡），日线、周线按大趋势卡。</p>
      </div>

      {/* ⑤ 接下来看什么 */}
      <div className="border-t border-line p-4">
        <h3 className="mb-2 text-sm font-semibold">
          接下来看什么 <span className="text-xs font-normal text-ink-3">都以收盘为准，收在哪 → 页面状态会变成什么</span>
        </h3>
        <ul className="space-y-2">
          {b.next.map((r) => (
            <li key={r.when} className="rounded-lg bg-panel-2 px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
                <span style={{ color: r.tone === "up" ? "var(--up)" : r.tone === "down" ? "var(--down)" : "var(--text-3)" }}>{toneIcon[r.tone]}</span>
                <span className="font-medium">{r.when}</span>
                <span className="text-ink-3">→</span>
                <span className="text-ink-2">{r.then}</span>
              </div>
              {r.fact && <p className="mt-0.5 pl-5 text-[11px] text-ink-3">{r.fact}</p>}
            </li>
          ))}
        </ul>
        {b.against && <p className="mt-2 rounded-lg bg-warn-soft px-3 py-1.5 text-[12px] text-ink">{b.against}</p>}
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">{b.foot}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-accent hover:bg-panel-2" onClick={() => onTab("watch")}>
            实时盯盘：等转强 →
          </button>
          <button className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-accent hover:bg-panel-2" onClick={() => onTab("plan")}>
            趋势与计划：认错位和仓位 →
          </button>
        </div>
      </div>
    </section>
  );
}
