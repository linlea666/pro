"use client";

import { useMemo, useState } from "react";
import type { Analysis, LightSummary } from "@/lib/analysis";
import { TF_HORIZON, TF_LABEL, type Timeframe } from "@/lib/types";
import { PriceChart, type OverlayLine, type PriceLineSpec } from "../PriceChart";
import { TrafficLight, lightMeta } from "../Light";
import { Term } from "../Term";
import { fmtPrice } from "./format";
import { LevelsList, ReliabilityBadge, Section } from "./shared";
import { MtfStrip } from "./MtfStrip";
import { Explain } from "../Explain";
import { PositionCalc } from "./PositionCalc";
import type { Mode } from "./CoinView";

export function Overview({ a, mtf, mode, onTf, onTab }: { a: Analysis; mtf: LightSummary[] | null; mode: Mode; onTf: (t: Timeframe) => void; onTab: (t: string) => void }) {
  const v = a.verdict;
  const meta = lightMeta(v.light);
  const [hoverLevel, setHoverLevel] = useState<number | null>(null);

  const lines = useMemo<OverlayLine[]>(
    () => [
      { data: a.indicators.overlays.ema20, color: "#e0a400", title: "EMA20" },
      { data: a.indicators.overlays.ema50, color: "#9085e9", title: "EMA50" },
    ],
    [a],
  );
  const priceLines = useMemo<PriceLineSpec[]>(() => {
    const out: PriceLineSpec[] = [
      ...a.levels.supports.slice(0, 2).map((l, k) => ({ price: l.price, color: "#199e70", title: `支撑${k + 1}` })),
      ...a.levels.resistances.slice(0, 2).map((l, k) => ({ price: l.price, color: "#e66767", title: `阻力${k + 1}` })),
    ];
    if (v.stopRef) out.push({ price: v.stopRef, color: "#e0a400", title: "止损参考", dashed: false });
    if (hoverLevel) out.push({ price: hoverLevel, color: "#3987e5", title: "", width: 2, dashed: false });
    return out;
  }, [a, v.stopRef, hoverLevel]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        {/* verdict */}
        <section className="card overflow-hidden">
          <div className="flex gap-4 p-5" style={{ background: `linear-gradient(90deg, ${meta.soft}, transparent 70%)` }}>
            <TrafficLight light={v.light} size={20} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span>{TF_LABEL[a.tf]}结论 · 适合{TF_HORIZON[a.tf]}</span>
                <span className="rounded-full border border-line px-2 py-0.5">信心：{v.confidence}</span>
                <span className="num rounded-full border border-line px-2 py-0.5" title="−100 极度偏空 … +100 极度偏多">综合分 {v.score > 0 ? "+" : ""}{v.score}</span>
              </div>
              <h2 className="mt-1.5 text-xl font-semibold leading-snug" style={{ color: meta.color }}>
                {meta.icon} {v.lightText}
              </h2>
              <p className="mt-1 text-[15px] leading-relaxed">{v.headline}</p>
            </div>
          </div>
          <div className="grid gap-px border-t border-line bg-line sm:grid-cols-2">
            {v.components.map((c) => (
              <div key={c.key} className="bg-panel p-4">
                <div className="flex items-center gap-2 text-xs text-ink-3">
                  <Explain k={`v:${c.key}`} variant="term">{c.label}</Explain>
                  <ScoreBar v={c.score} />
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{c.text}</p>
              </div>
            ))}
          </div>
          <div className="border-t border-line p-5">
            <h3 className="mb-2 text-sm font-semibold">参考思路（学习用，不是投资建议）</h3>
            <ul className="space-y-1.5 text-[13px] leading-relaxed text-ink-2">
              {v.plan.map((p) => (
                <li key={p} className="flex gap-2">
                  <span className="text-ink-3">•</span>
                  {p}
                </li>
              ))}
            </ul>
            {v.stopText && (
              <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-ink">
                <b className="text-warn">⚠ 认错位：</b>
                {v.stopText}
              </p>
            )}
          </div>
        </section>

        <section className="card p-3">
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-ink-3">
            <span>图上：</span>
            <span><span className="mr-1 inline-block h-0.5 w-3 bg-up align-middle" />绿色虚线 = 支撑</span>
            <span><span className="mr-1 inline-block h-0.5 w-3 bg-down align-middle" />红色虚线 = 阻力</span>
            <span><span className="mr-1 inline-block h-0.5 w-3 bg-warn align-middle" />黄线 = 止损参考 / EMA20</span>
          </div>
          <PriceChart candles={a.candles} lines={lines} priceLines={priceLines} height={400} />
        </section>
      </div>

      <div className="space-y-4">
        <MtfStrip kind="light" mtf={mtf} current={a.tf} onTf={onTf} title="多周期信号灯" />
        {mode === "beginner" && <p className="-mt-2 px-1 text-[11px] leading-relaxed text-ink-3">大周期决定方向，小周期决定时机。日线偏多时，在 4 小时、1 小时回调时找机会更稳。</p>}

        <Section title="最近出现的信号" extra={<button className="text-[11px] text-accent" onClick={() => onTab("td")}>查看全部 →</button>}>
          {a.active.length === 0 ? (
            <p className="text-[13px] text-ink-3">最近 {Math.max(3, Math.round(a.stats[0]?.horizon / 3))} 根 K 线内没有出现我们统计的典型信号。</p>
          ) : (
            <ul className="space-y-2.5">
              {a.active.map((s) => (
                <li key={s.key} className="rounded-lg bg-panel-2 p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span style={{ color: s.side === "bull" ? "var(--up)" : "var(--down)" }}>{s.side === "bull" ? "↑" : "↓"}</span>
                    <span className="font-medium">{s.name}</span>
                    <span className="text-[11px] text-ink-3">{s.barsAgo === 0 ? "当前 K 线" : `${s.barsAgo} 根前`}</span>
                    <span className="ml-auto"><ReliabilityBadge r={s.stats.reliability} /></span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-2">
                    {s.stats.winRate == null
                      ? "历史样本太少，无法判断可靠性。"
                      : `过去在${a.coin} ${TF_LABEL[a.tf]}出现 ${s.stats.samples} 次，${a.horizonText}后${s.side === "bull" ? "上涨" : "下跌"}的比例 ${s.stats.winRate}%（随机 ${s.stats.baseWinRate}%），按信号操作平均${(s.stats.avgReturn ?? 0) >= 0 ? "赚" : "亏"} ${Math.abs(s.stats.avgReturn ?? 0).toFixed(1)}%。`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={<>关键价位 <span className="text-xs font-normal text-ink-3">（<Term k="支撑">支撑</Term> / <Term k="阻力">阻力</Term>）</span></>}>
          <LevelsList supports={a.levels.supports} resistances={a.levels.resistances} price={a.price} mode={mode} onHover={setHoverLevel} />
        </Section>

        <PositionCalc price={a.price} stopRef={v.stopRef} coin={a.coin} />
      </div>
    </div>
  );
}

function ScoreBar({ v }: { v: number }) {
  const w = Math.min(50, Math.abs(v) / 2);
  const color = v > 0 ? "var(--up)" : v < 0 ? "var(--down)" : "var(--text-3)";
  return (
    <span className="ml-auto inline-flex items-center gap-2" title="−100 偏空 … +100 偏多">
      <span className="relative inline-block h-1.5 w-20 rounded-full bg-panel-2">
        <span className="absolute inset-y-0 left-1/2 w-px bg-ink-3" />
        <span className="absolute inset-y-0 rounded-full" style={{ width: `${w}%`, left: v >= 0 ? "50%" : `${50 - w}%`, background: color }} />
      </span>
      <span className="num w-8 text-right text-[11px]" style={{ color }}>
        {v > 0 ? "+" : ""}
        {v}
      </span>
    </span>
  );
}

export { fmtPrice };
