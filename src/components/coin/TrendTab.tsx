"use client";

import { useMemo } from "react";
import type { Analysis } from "@/lib/analysis";
import { TF_LABEL } from "@/lib/types";
import { PriceChart, type OverlayLine, type SubPane } from "../PriceChart";
import { Term } from "../Term";
import { biasColor, biasIcon } from "./format";
import { Explainer, Section } from "./shared";
import type { Mode } from "./CoinView";

const TREND_IDS = ["ema_cross", "golden_cross", "ma_stack", "price_sma200", "macd", "adx", "psar", "aroon", "ichimoku", "slope"];

export function TrendTab({ a, mode }: { a: Analysis; mode: Mode }) {
  const t = a.trend;
  const color = t.current >= 15 ? "var(--up)" : t.current <= -15 ? "var(--down)" : "var(--warn)";

  const lines = useMemo<OverlayLine[]>(
    () => [
      { data: a.indicators.overlays.ema20, color: "#e0a400", title: "EMA20" },
      { data: a.indicators.overlays.ema50, color: "#9085e9", title: "EMA50" },
      { data: a.indicators.overlays.sma200, color: "#3987e5", title: "MA200", width: 2 },
    ],
    [a],
  );
  const panes = useMemo<SubPane[]>(
    () => [
      {
        title: "趋势强度",
        kind: "histogram",
        data: t.series,
        colors: t.series.map((v) => (v == null ? undefined : v >= 15 ? "#199e70" : v <= -15 ? "#e66767" : "#7d889666")),
        height: 140,
        guides: [
          { value: 15, color: "#199e70" },
          { value: -15, color: "#e66767" },
        ],
      },
    ],
    [t],
  );

  const voters = a.indicators.readings.filter((r) => TREND_IDS.includes(r.id));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <section className="card p-3">
          <PriceChart candles={a.candles} lines={lines} panes={panes} height={380} initialBars={220} />
          <p className="mt-1 px-1 text-[11px] text-ink-3">副图：绿色柱 = 上涨趋势，红色柱 = 下跌趋势，灰色 = 震荡（−15 到 +15 之间）。</p>
        </section>
        <Explainer title="趋势强度是怎么算的？" defaultOpen={mode === "beginner"}>
          <p>我们让 10 个趋势类指标（均线、MACD、ADX、SAR、云图、斜率等）投票，按可靠程度加权得到方向；再用 <Term k="ADX">ADX</Term> 判断力度。ADX 低时，就算投票偏向一边，分数也会被压低，因为震荡市里的“方向”不可靠。</p>
          <p>
            <b className="text-ink">怎么用：</b>+45 以上是强势上涨，顺势而为；−15 到 +15 是震荡，最容易来回亏钱，新手最好休息；−45 以下是强势下跌，不要逆势抄底。
          </p>
        </Explainer>
      </div>
      <div className="space-y-4">
        <Section title={`当前趋势 · ${TF_LABEL[a.tf]}`}>
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-semibold" style={{ color }}>
              {t.current >= 15 ? "↑" : t.current <= -15 ? "↓" : "→"} {t.label}
            </span>
            <span className="num text-sm text-ink-3">强度 {t.current > 0 ? "+" : ""}{t.current} / 100</span>
          </div>
          <Gauge v={t.current} />
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{t.explain}</p>
          <div className="mt-2 text-xs text-ink-3">ADX {t.adx}（{t.adx < 20 ? "无趋势" : t.adx < 25 ? "趋势较弱" : t.adx < 40 ? "趋势成立" : "趋势很强"}）</div>
        </Section>
        <Section title="趋势投票明细">
          <ul className="space-y-2">
            {voters.map((r) => (
              <li key={r.id} className="flex gap-2 text-[13px]">
                <span className="w-4 shrink-0 text-center" style={{ color: biasColor(r.bias) }}>{biasIcon(r.bias)}</span>
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-ink-2">{r.reason}</div>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function Gauge({ v }: { v: number }) {
  const pos = (v + 100) / 2;
  return (
    <div className="mt-3">
      <div className="relative h-2 rounded-full" style={{ background: "linear-gradient(90deg, var(--down), var(--border) 42%, var(--border) 58%, var(--up))" }}>
        <span className="absolute -top-1 h-4 w-1.5 -translate-x-1/2 rounded bg-ink" style={{ left: `${pos}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-ink-3">
        <span>强势下跌</span>
        <span>震荡</span>
        <span>强势上涨</span>
      </div>
    </div>
  );
}
