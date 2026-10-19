"use client";

import { useEffect, useMemo, useState } from "react";
import type { Candle } from "@/lib/types";
import { BEGINNER_TIMEFRAMES, TF_LABEL, TIMEFRAMES, type Timeframe } from "@/lib/types";
import { PriceChart, type PriceLineSpec } from "../PriceChart";
import { Term } from "../Term";
import { fmtPct, fmtPrice } from "./format";
import { Explainer, MethodChips, Section, Strength } from "./shared";
import { MtfStrip } from "./MtfStrip";
import type { TabProps } from "./CoinView";

const TIERS = [1, 2, 3, 4, 5];

export function LevelsTab({ a, mtf, mode, onTf }: TabProps) {
  const [focus, setFocus] = useState<number | null>(null);
  const [tiers, setTiers] = useState(mode === "pro" ? 5 : 3);
  const [chartTf, setChartTf] = useState<Timeframe>(a.tf);
  const [chartCandles, setChartCandles] = useState<Candle[] | null>(null);

  // the chart follows the analysis timeframe unless the user picks another one
  useEffect(() => setChartTf(a.tf), [a.tf, a.coin]);
  useEffect(() => {
    if (chartTf === a.tf) return setChartCandles(null);
    let alive = true;
    fetch(`/api/candles?coin=${a.coin}&tf=${chartTf}`)
      .then((r) => r.json())
      .then((b) => alive && setChartCandles(b.candles ?? null))
      .catch(() => alive && setChartCandles(null));
    return () => {
      alive = false;
    };
  }, [chartTf, a.tf, a.coin]);

  const res = a.levels.resistances.slice(0, tiers);
  const sup = a.levels.supports.slice(0, tiers);
  const all = [...res].reverse().concat(sup);

  const priceLines = useMemo<PriceLineSpec[]>(
    () => [
      ...res.map((l, k) => ({ price: l.price, color: "#e66767", title: `阻力${k + 1}`, width: (focus === l.price ? 2 : 1) as 1 | 2, dashed: focus !== l.price })),
      ...sup.map((l, k) => ({ price: l.price, color: "#199e70", title: `支撑${k + 1}`, width: (focus === l.price ? 2 : 1) as 1 | 2, dashed: focus !== l.price })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a, focus, tiers],
  );

  const s1 = sup[0], r1 = res[0];
  const candles = chartTf === a.tf ? a.candles : chartCandles;
  const tfs = mode === "pro" ? TIMEFRAMES : BEGINNER_TIMEFRAMES;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-4">
        <section className="card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="text-ink-3">图表周期</span>
              {tfs.map((t) => (
                <button key={t} className="chip !px-2 !py-0.5 !text-xs" data-active={chartTf === t} onClick={() => setChartTf(t)}>
                  {TF_LABEL[t]}
                </button>
              ))}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-ink-3">档位</span>
              {TIERS.map((n) => (
                <button key={n} className="chip !px-2 !py-0.5 !text-xs" data-active={tiers >= n} onClick={() => setTiers(n)} aria-label={`每侧显示 ${n} 个`}>
                  {n}
                </button>
              ))}
            </span>
          </div>
          {chartTf !== a.tf && (
            <p className="mb-1 px-1 text-[11px] text-ink-3">
              正在 {TF_LABEL[chartTf]} 图上查看 {TF_LABEL[a.tf]} 分析出的关键位。
            </p>
          )}
          {candles ? <PriceChart candles={candles} priceLines={priceLines} height={480} initialBars={220} /> : <div className="h-[480px] animate-pulse rounded bg-panel-2" />}
        </section>
        <Explainer title="3 分钟看懂支撑与阻力" defaultOpen={mode === "beginner"}>
          <p>
            <Term k="支撑">支撑</Term>是“跌到这里容易有人买”的价位，<Term k="阻力">阻力</Term>是“涨到这里容易有人卖”的价位。它们来自过去的高低点、成交密集区、均线等。
          </p>
          <p>
            <b className="text-ink">我们怎么算：</b>用 14 种公开方法在多个周期上各自算出候选价位，再把距离很近的合并。被越多方法、越多周期同时指向的价位，强度越高。点击每个价位下面的方法标签，可以看到这种方法是什么、为什么这里有它。
          </p>
          <p>
            <b className="text-ink">怎么用：</b>买在支撑附近、卖在阻力附近；止损放在支撑下方一点。价格有效跌破支撑后，这个支撑往往会变成新的阻力。
          </p>
          <p>
            <b className="text-ink">档位：</b>每侧显示几个关键位。新手看 2–3 个就够了，太多反而看不清。
          </p>
        </Explainer>
      </div>

      <div className="space-y-4">
        <MtfStrip kind="levels" mtf={mtf} current={a.tf} onTf={onTf} />
        <Section title="现在的位置">
          <p className="text-[13px] leading-relaxed text-ink-2">
            {s1 && r1 ? (
              <>
                价格 <b className="num text-ink">{fmtPrice(a.price)}</b> 夹在支撑 <b className="num text-up">{fmtPrice(s1.price)}</b>（{fmtPct(s1.distancePct, 1)}）和阻力{" "}
                <b className="num text-down">{fmtPrice(r1.price)}</b>（{fmtPct(r1.distancePct, 1)}）之间。
                {Math.abs(s1.distancePct) < Math.abs(r1.distancePct) ? "离支撑更近：如果想买，这里的风险收益比相对好。" : "离阻力更近：现在追买的空间有限，等回踩或突破更稳。"}
              </>
            ) : (
              "附近没有找到足够强的价位。"
            )}
          </p>
        </Section>
        <Section title="关键价位（按价格）">
          <ul className="space-y-2">
            {all.map((l) => {
              const isRes = l.side === "resistance";
              const color = isRes ? "var(--down)" : "var(--up)";
              const rank = (isRes ? res : sup).indexOf(l) + 1;
              return (
                <li
                  key={l.price}
                  className="rounded-xl border p-3 transition"
                  style={{ borderColor: focus === l.price ? color : "var(--border)" }}
                  onMouseEnter={() => setFocus(l.price)}
                  onMouseLeave={() => setFocus(null)}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="num text-xl font-semibold" style={{ color }}>
                      {fmtPrice(l.price)}
                    </span>
                    <span className="num text-xs text-ink-3">{fmtPct(l.distancePct, 2)}</span>
                    <span className="ml-auto text-xs font-medium" style={{ color }}>
                      {isRes ? "↑ 阻力" : "↓ 支撑"} #{rank}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
                    <Strength v={l.strength} />
                    <span>· 共振分 {l.score}</span>
                    <span>· {l.methods.length} 种方法 · {l.contributions} 个贡献</span>
                    <span>· {l.timeframes.map((t) => TF_LABEL[t]).join(" / ")}</span>
                  </div>
                  <MethodChips level={l} max={mode === "pro" ? 8 : 3} />
                  {mode === "pro" && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">{l.labels.join(" · ")}</p>}
                </li>
              );
            })}
          </ul>
        </Section>
      </div>
    </div>
  );
}
