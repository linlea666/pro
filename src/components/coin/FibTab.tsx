"use client";

import { useEffect, useMemo, useState } from "react";
import { fibFromSwing, type FibResult } from "@/lib/ta/fib";
import type { Pivot } from "@/lib/ta/zigzag";
import { PriceChart, type PriceLineSpec, type Segment } from "../PriceChart";
import { Term } from "../Term";
import { fmtPrice } from "./format";
import { Explainer, Section } from "./shared";
import type { TabProps } from "./CoinView";
import { MtfStrip } from "./MtfStrip";

const KEY_RATIOS = new Set([0.382, 0.5, 0.618]);

export function FibTab({ a, mtf, mode, onTf }: TabProps) {
  const [manual, setManual] = useState<{ a?: Pivot; b?: Pivot } | null>(null);
  useEffect(() => setManual(null), [a.coin, a.tf]);

  const fib: FibResult | null = useMemo(() => {
    if (manual?.a && manual?.b) return fibFromSwing(manual.a, manual.b, a.price);
    return a.fib;
  }, [manual, a]);

  const priceLines = useMemo<PriceLineSpec[]>(
    () =>
      fib
        ? fib.levels
            .filter((l) => l.kind === "retrace" || mode === "pro" || l.ratio === 1.618)
            .map((l) => ({
              price: l.price,
              color: l.kind === "extension" ? "#9085e9" : KEY_RATIOS.has(l.ratio) ? "#e0a400" : "#7d8896",
              title: `${l.kind === "extension" ? "扩展 " : ""}${(l.ratio * 100).toFixed(1)}%`,
              dashed: !KEY_RATIOS.has(l.ratio),
            }))
        : [],
    [fib, mode],
  );
  const segments = useMemo<Segment[]>(
    () => (fib ? [{ points: [{ t: fib.a.t, v: fib.a.price }, { t: fib.b.t, v: fib.b.price }], color: "#3987e5", width: 2, dashed: true }] : []),
    [fib],
  );

  const onPick = (p: { t: number; price: number; index: number }) => {
    if (!manual) return;
    const c = a.candles[p.index];
    // snap to whichever extreme of the clicked candle is closer
    const kind: Pivot["kind"] = Math.abs(p.price - c.h) < Math.abs(p.price - c.l) ? "high" : "low";
    const pv: Pivot = { i: p.index, t: c.t, price: kind === "high" ? c.h : c.l, kind };
    setManual(manual.a && !manual.b ? { a: manual.a, b: pv } : { a: pv });
  };

  const zone = fib ? Math.max(0, fib.currentRatio) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <section className="card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs">
            <button className="chip !text-xs" data-active={!manual} onClick={() => setManual(null)}>
              自动识别波段
            </button>
            <button className="chip !text-xs" data-active={!!manual} onClick={() => setManual({})}>
              手动选点
            </button>
            {manual && (
              <span className="text-ink-2">
                {!manual.a ? "① 在图上点击波段起点（A）" : !manual.b ? "② 再点击波段终点（B）" : "已画好。再点击可以重新选 A 点。"}
              </span>
            )}
          </div>
          <PriceChart candles={a.candles} priceLines={priceLines} segments={segments} height={460} initialBars={200} onPick={manual ? onPick : undefined} />
        </section>
        <Explainer title="3 分钟看懂斐波那契" defaultOpen={mode === "beginner"}>
          <p>
            价格很少一口气涨完或跌完，中途总会回调。<Term k="斐波那契">斐波那契回撤</Term>把一段行情按 23.6% / 38.2% / 50% / 61.8% / 78.6% 切开，这些位置经常成为回调的终点。
          </p>
          <p>
            <b className="text-ink">黄金区间：</b>38.2%–61.8%（图中黄色实线）。上涨中回调到这里并止跌，是很多人的“上车点”；回调超过 78.6%，原来的上涨很可能已经结束。
          </p>
          <p>
            <b className="text-ink">自动识别：</b>我们用 ATR 过滤小波动，自动找到最近一段有意义的涨跌，省去新手自己选点的麻烦。熟练后可以切换“手动选点”。
          </p>
        </Explainer>
      </div>
      <div className="space-y-4">
        <MtfStrip kind="fib" mtf={mtf} current={a.tf} onTf={onTf} />
        <Section title="当前回调程度">
          {fib ? (
            <>
              <p className="text-[13px] leading-relaxed">
                {fib.direction === "up" ? "最近一段上涨" : "最近一段下跌"}：从 <b className="num">{fmtPrice(fib.a.price)}</b> 到 <b className="num">{fmtPrice(fib.b.price)}</b>
                {fib.b.provisional && <span className="text-ink-3">（终点可能还在变化）</span>}。
              </p>
              <div className="mt-3">
                <div className="relative h-3 rounded-full bg-panel-2">
                  <div className="absolute inset-y-0 rounded-full bg-warn-soft" style={{ left: "38.2%", width: "23.6%" }} />
                  <span className="absolute -top-1 h-5 w-1.5 -translate-x-1/2 rounded bg-ink" style={{ left: `${Math.min(100, zone * 100)}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-ink-3 num">
                  <span>0%（B 点）</span>
                  <span>38.2–61.8%</span>
                  <span>100%（A 点）</span>
                </div>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
                已回撤 <b className="num text-ink">{(fib.currentRatio * 100).toFixed(1)}%</b>：{fib.zoneText}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-ink-3">没有识别到足够大的波段。</p>
          )}
        </Section>
        {fib && (
          <Section title="各比例价位">
            <table className="w-full text-[13px] num">
              <tbody>
                {fib.levels
                  .filter((l) => l.kind === "retrace" || mode === "pro" || l.ratio === 1.618)
                  .sort((x, y) => y.price - x.price)
                  .map((l) => (
                    <tr key={`${l.kind}${l.ratio}`} className="border-b border-line last:border-0">
                      <td className="py-1.5 text-ink-3">
                        {l.kind === "extension" ? "扩展 " : ""}
                        {(l.ratio * 100).toFixed(1)}%{KEY_RATIOS.has(l.ratio) && <span className="ml-1 text-warn">★</span>}
                      </td>
                      <td className="py-1.5 text-right">{fmtPrice(l.price)}</td>
                      <td className="py-1.5 text-right text-xs" style={{ color: l.price > a.price ? "var(--down)" : "var(--up)" }}>
                        {l.price > a.price ? "上方" : "下方"} {(((l.price - a.price) / a.price) * 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Section>
        )}
      </div>
    </div>
  );
}
