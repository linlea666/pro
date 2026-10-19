"use client";

import { useMemo, useState } from "react";
import { CATEGORY_LABEL, type Category } from "@/lib/types";
import { PriceChart, type OverlayLine, type SubPane } from "../PriceChart";
import { Term } from "../Term";
import { biasColor, biasIcon, biasText } from "./format";
import { Explainer, Section, StatsTable } from "./shared";
import type { TabProps } from "./CoinView";
import { MtfStrip } from "./MtfStrip";
import { Explain } from "../Explain";
import { TF_LABEL } from "@/lib/types";

const CATS: Category[] = ["trend", "momentum", "volatility", "volume", "pattern"];
const CAT_HINT: Record<Category, string> = {
  trend: "大方向往哪走",
  momentum: "涨跌的劲儿大不大、是否过热",
  volatility: "波动大小、是否偏离太远",
  volume: "资金是在流入还是流出",
  pattern: "K 线组合形态",
};

export function IndicatorsTab({ a, mtf, mode, onTf }: TabProps) {
  const [cat, setCat] = useState<Category | "all">("all");
  const [pane, setPane] = useState<"resonance" | "rsi" | "macd">("resonance");
  const s = a.indicators.summary;
  const bull = CATS.reduce((x, k) => x + s[k].bull, 0);
  const bear = CATS.reduce((x, k) => x + s[k].bear, 0);
  const neutral = a.indicators.total - bull - bear;

  const lines = useMemo<OverlayLine[]>(
    () => [
      { data: a.indicators.overlays.ema20, color: "#e0a400", title: "EMA20" },
      { data: a.indicators.overlays.ema50, color: "#9085e9", title: "EMA50" },
      { data: a.indicators.overlays.sma200, color: "#3987e5", title: "MA200", width: 2 },
      ...(mode === "pro"
        ? [
            { data: a.indicators.overlays.bbUpper, color: "#7d8896", title: "布林上", dashed: true },
            { data: a.indicators.overlays.bbLower, color: "#7d8896", title: "布林下", dashed: true },
          ]
        : []),
    ],
    [a, mode],
  );

  const panes = useMemo<SubPane[]>(() => {
    if (pane === "rsi")
      return [{ title: "RSI", kind: "line", data: a.indicators.rsi, color: "#9085e9", height: 120, guides: [{ value: 70, color: "#e66767", title: "超买" }, { value: 30, color: "#199e70", title: "超卖" }] }];
    if (pane === "macd")
      return [
        {
          title: "MACD",
          kind: "histogram",
          data: a.indicators.macd.hist,
          colors: a.indicators.macd.hist.map((v) => (v == null ? undefined : v >= 0 ? "#199e7099" : "#e6676799")),
          height: 120,
          extra: [
            { data: a.indicators.macd.line, color: "#3987e5" },
            { data: a.indicators.macd.signal, color: "#e0a400" },
          ],
        },
      ];
    return [
      {
        title: "多空净票数",
        kind: "histogram",
        data: a.indicators.resonance.map((r) => r.net),
        colors: a.indicators.resonance.map((r) => (r.net > 0 ? "#199e70" : r.net < 0 ? "#e66767" : "#7d8896")),
        height: 120,
      },
    ];
  }, [a, pane]);

  const readings = a.indicators.readings.filter((r) => cat === "all" || r.category === cat);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0 space-y-4">
        <section className="card p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className="text-xs text-ink-3">{a.indicators.total} 个指标此刻的投票</div>
              <div className="mt-1 flex items-baseline gap-3 text-2xl font-semibold num">
                <span style={{ color: "var(--up)" }}>↑{bull}</span>
                <span style={{ color: "var(--down)" }}>↓{bear}</span>
                <span className="text-base text-ink-3">· {neutral} 中性</span>
              </div>
            </div>
            <VoteBar bull={bull} bear={bear} total={a.indicators.total} />
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            {bull - bear >= 6
              ? "多数指标看多，形成了“共振”。不过共振出现时往往已经涨了一段，注意别追在高点。"
              : bear - bull >= 6
                ? "多数指标看空，形成了“共振”。下跌共振时不宜抄底，等看空的指标减少再说。"
                : "多空指标数量接近，没有形成共振，市场处在犹豫阶段。"}
          </p>
        </section>

        <section className="card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs">
            <span className="text-ink-3">副图：</span>
            {(
              [
                ["resonance", "多空共振"],
                ["rsi", "RSI"],
                ["macd", "MACD"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className="chip !py-0.5 !text-xs" data-active={pane === k} onClick={() => setPane(k)}>
                {l}
              </button>
            ))}
          </div>
          <PriceChart candles={a.candles} lines={lines} panes={panes} height={360} />
          {pane === "resonance" && <p className="mt-1 px-1 text-[11px] text-ink-3">副图每根柱子 = 当时看多指标数 − 看空指标数。柱子越高，共振越强。</p>}
        </section>

        <Section title="以前灵不灵？">
          <StatsTable stats={a.stats} horizonText={a.horizonText} coin={a.coin} tf={a.tf} only={["reso_bull", "reso_bear", "ema_golden", "ema_death", "rsi_oversold", "rsi_overbought"]} />
        </Section>
      </div>

      <div className="space-y-4">
        <MtfStrip kind="indicators" mtf={mtf} current={a.tf} onTf={onTf} />
        <Section title="分类看">
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button className="chip !text-xs" data-active={cat === "all"} onClick={() => setCat("all")}>
              全部
            </button>
            {CATS.map((k) => (
              <button key={k} className="chip !text-xs" data-active={cat === k} onClick={() => setCat(k)}>
                {CATEGORY_LABEL[k]} <span className="num" style={{ color: "var(--up)" }}>{s[k].bull}</span>/<span className="num" style={{ color: "var(--down)" }}>{s[k].bear}</span>
              </button>
            ))}
          </div>
          {cat !== "all" && <p className="mb-2 text-xs text-ink-3">{CATEGORY_LABEL[cat]}类指标：{CAT_HINT[cat]}</p>}
          <ul className="max-h-[720px] space-y-1.5 overflow-y-auto pr-1">
            {readings.map((r) => (
              <li key={r.id} className="rounded-lg border border-line p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.name}</span>
                  <Explain
                    k={`ind:${r.id}`}
                    variant="icon"
                    now={r.reason}
                    stats={{ ...a.indicatorStats[r.id], horizonText: a.horizonText, scope: `${a.coin} ${TF_LABEL[a.tf]}` }}
                  />
                  {mode === "pro" && r.value != null && <span className="num text-[11px] text-ink-3">{Math.abs(r.value) > 1e6 ? r.value.toExponential(2) : r.value.toFixed(2)}</span>}
                  <span className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: biasColor(r.bias), border: `1px solid ${biasColor(r.bias)}` }}>
                    {biasIcon(r.bias)} {biasText(r.bias)}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-2">{r.reason}</p>
              </li>
            ))}
          </ul>
        </Section>
        <Explainer title="为什么要看这么多指标？">
          <p>每个指标都只看到市场的一个侧面，单独用很容易被骗。把趋势、动量、波动、量能、形态五类指标放在一起“投票”，大多数同向时（共振），信号才更可靠。</p>
          <p>
            新手先认识这几个就够了：<Term k="均线">均线</Term>、<Term k="MACD">MACD</Term>、<Term k="RSI">RSI</Term>、<Term k="布林带">布林带</Term>、<Term k="成交量">成交量</Term>。
          </p>
          <p>注意：动量类指标（RSI、KD 等）看多的意思通常是“跌过头了、可能反弹”，而不是“趋势向上”，和趋势类指标的含义不一样。</p>
        </Explainer>
      </div>
    </div>
  );
}

function VoteBar({ bull, bear, total }: { bull: number; bear: number; total: number }) {
  const n = total - bull - bear;
  return (
    <div className="flex h-3 min-w-[200px] flex-1 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
      <div style={{ flex: bull, background: "var(--up)" }} />
      <div style={{ flex: n, background: "var(--border)" }} />
      <div style={{ flex: bear, background: "var(--down)" }} />
    </div>
  );
}
