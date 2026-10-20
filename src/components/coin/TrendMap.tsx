"use client";

import type { TrendMapRow, TrendPlan } from "@/lib/trendplan";
import { TF_LABEL } from "@/lib/types";
import { Term } from "../Term";
import type { Mode } from "./CoinView";

const ROLE: Record<TrendMapRow["role"], string> = { context: "大背景", filter: "定方向", entry: "找入场", reference: "参考" };

export const dirColor = (d: number) => (d > 0 ? "var(--up)" : d < 0 ? "var(--down)" : "var(--text-3)");
const dirIcon = (d: number) => (d > 0 ? "↑" : d < 0 ? "↓" : "→");

/** The two-level state of a trend's protective swing (or of a key level), judged on closes only. */
export function BreachBadge({ breach, level = false }: { breach: "none" | "pierced" | "broken"; level?: boolean }) {
  if (breach === "none") return null;
  const broken = breach === "broken";
  return (
    <span
      className="whitespace-nowrap rounded-full border px-1.5 py-px text-[11px]"
      style={{ color: broken ? "var(--down)" : "var(--warn)", borderColor: broken ? "var(--down)" : "var(--warn)" }}
      title="只看收盘价：越过保护位 0.1 倍 ATR 为“被刺穿·观察”，越过 0.8 倍 ATR 为“失效”"
    >
      {broken ? (level ? "失效" : "保护位失效") : "被刺穿·观察"}
    </span>
  );
}

/**
 * What trend each timeframe is in and where price sits in it, biggest first.
 * `compact` (on the overview) adds both plans in one line and a link to the plan tab.
 */
export function TrendMap({ p, mode, compact = false, onOpen }: { p: TrendPlan; mode: Mode; compact?: boolean; onOpen?: () => void }) {
  const rows = p.map.filter((m) => mode === "pro" || m.role !== "reference");
  const fdir = p.map.find((m) => m.role === "filter")?.direction ?? 0;
  const soft = fdir > 0 ? "var(--up-soft)" : fdir < 0 ? "var(--down-soft)" : "var(--panel-2)";
  return (
    <section className="card overflow-hidden">
      <div className="p-5" style={{ background: `linear-gradient(90deg, ${soft}, transparent 70%)` }}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>
            <Term k="结构">趋势地图</Term> · {TF_LABEL[p.filterTf]}定方向、{TF_LABEL[p.tf]}找入场
          </span>
          {p.replay && <span className="rounded-full border border-warn px-2 py-0.5 text-warn">回放</span>}
        </div>
        <h2 className="mt-1.5 text-xl font-semibold leading-snug">{p.headline}</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{p.bias}</p>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {rows.map((m) => (
          <li key={m.tf} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 px-5 py-2.5">
            <div>
              <div className="text-sm font-medium">{TF_LABEL[m.tf]}</div>
              <div className="text-[11px] text-ink-3">{ROLE[m.role]}</div>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span style={{ color: dirColor(m.direction) }} aria-hidden="true">{dirIcon(m.direction)}</span>
                <span className="font-medium">{m.view.label}</span>
                <BreachBadge breach={m.view.breach} />
              </div>
              {m.view.position && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{m.view.position}</p>}
            </div>
          </li>
        ))}
      </ul>
      {compact && (
        <div className="space-y-1 border-t border-line px-5 py-3 text-[13px] leading-relaxed">
          <p>
            <span className="text-up">多：</span>
            {p.long.headline}
          </p>
          <p>
            <span className="text-down">空：</span>
            {p.short.headline}
          </p>
          <button className="mt-1 text-xs text-accent" onClick={onOpen}>
            看完整的交易计划、认错位和仓位 →
          </button>
        </div>
      )}
    </section>
  );
}
