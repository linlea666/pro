"use client";

import { useMemo, useState } from "react";
import type { Analysis } from "@/lib/analysis";
import { TF_LABEL } from "@/lib/types";
import { PriceChart, type PriceLineSpec } from "../PriceChart";
import { Term } from "../Term";
import { fmtPct, fmtPrice } from "./format";
import { Explainer, Section, Strength } from "./shared";
import type { Mode } from "./CoinView";

export function LevelsTab({ a, mode }: { a: Analysis; mode: Mode }) {
  const [focus, setFocus] = useState<number | null>(null);
  const all = [...a.levels.resistances].reverse().concat(a.levels.supports);

  const priceLines = useMemo<PriceLineSpec[]>(
    () => [
      ...a.levels.resistances.map((l, k) => ({ price: l.price, color: "#e66767", title: `阻力${k + 1}`, width: (focus === l.price ? 2 : 1) as 1 | 2, dashed: focus !== l.price })),
      ...a.levels.supports.map((l, k) => ({ price: l.price, color: "#199e70", title: `支撑${k + 1}`, width: (focus === l.price ? 2 : 1) as 1 | 2, dashed: focus !== l.price })),
    ],
    [a, focus],
  );

  const s1 = a.levels.supports[0], r1 = a.levels.resistances[0];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-4">
        <section className="card p-3">
          <PriceChart candles={a.candles} priceLines={priceLines} height={480} initialBars={220} />
        </section>
        <Explainer title="3 分钟看懂支撑与阻力" defaultOpen={mode === "beginner"}>
          <p>
            <Term k="支撑">支撑</Term>是“跌到这里容易有人买”的价位，<Term k="阻力">阻力</Term>是“涨到这里容易有人卖”的价位。它们来自过去的高低点、成交密集区、均线等。
          </p>
          <p>
            <b className="text-ink">我们怎么算：</b>用 14 种公开方法（摆动高低、分形、成交量分布、经典/Camarilla/斐波那契 Pivot、前日/周/月高低、Donchian、Keltner、布林带、均线、锚定 VWAP、斐波那契回撤、整数关口），在 15 分钟到周线多个周期上各自算出候选价位，再把距离很近的合并。被越多方法、越多周期同时指向的价位，强度越高。
          </p>
          <p>
            <b className="text-ink">怎么用：</b>买在支撑附近、卖在阻力附近；止损放在支撑下方一点。价格有效跌破支撑后，这个支撑往往会变成新的阻力。
          </p>
        </Explainer>
      </div>

      <div className="space-y-4">
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
              const res = l.side === "resistance";
              const color = res ? "var(--down)" : "var(--up)";
              const rank = (res ? a.levels.resistances : a.levels.supports).indexOf(l) + 1;
              return (
                <li
                  key={l.price}
                  className="cursor-default rounded-xl border p-3 transition"
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
                      {res ? "↑ 阻力" : "↓ 支撑"} #{rank}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ink-3">
                    <Strength v={l.strength} />
                    <span>· 共振分 {l.score}</span>
                    <span>· {l.methods.length} 种方法 · {l.contributions} 个贡献</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {l.timeframes.map((t) => (
                      <span key={t} className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2">{TF_LABEL[t]}</span>
                    ))}
                    {l.methods.slice(0, mode === "pro" ? 8 : 3).map((m, k) => (
                      <span key={m} className="rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-2">
                        {k === 0 ? "★ " : ""}
                        {m}
                      </span>
                    ))}
                  </div>
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
