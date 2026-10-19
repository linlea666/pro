"use client";

import type { Analysis } from "@/lib/analysis";
import { TF_LABEL, type Timeframe } from "@/lib/types";
import { fmtPct } from "./format";

const JUMPS: { label: string; sec: number }[] = [
  { label: "1 天前", sec: 86400 },
  { label: "3 天前", sec: 3 * 86400 },
  { label: "1 周前", sec: 7 * 86400 },
  { label: "2 周前", sec: 14 * 86400 },
  { label: "1 个月前", sec: 30 * 86400 },
  { label: "3 个月前", sec: 90 * 86400 },
];

const when = (t: number) => new Date(t * 1000).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** 时光机 controls: jump back, pick a bar on the chart, step bar by bar, see what happened next. */
export function ReplayBar({
  tf,
  asOf,
  picking,
  data,
  live,
  error,
  onPicking,
  onAsOf,
}: {
  tf: Timeframe;
  asOf: number | null;
  picking: boolean;
  data: Analysis | null;
  live: Analysis | null;
  error: string | null;
  onPicking: (v: boolean) => void;
  onAsOf: (t: number | null) => void;
}) {
  // jump targets snap to real bars of the live chart (minus the bar still forming)
  const bars = live?.candles ?? [];
  const lastT = bars.length ? bars[bars.length - 1].t : 0;
  const jumps = JUMPS.map((j) => {
    const target = lastT - j.sec;
    let idx = -1;
    for (let i = bars.length - 2; i >= 0; i--) if (bars[i].t <= target) { idx = i; break; }
    return { ...j, t: idx >= 0 ? bars[idx].t : null };
  }).filter((j) => j.t != null);

  if (!asOf) {
    return (
      <div className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs ${picking ? "border-warn/60 bg-warn-soft" : "border-line"}`}>
        <span className="font-medium text-ink">🕰 时光机</span>
        {picking ? (
          <>
            <span className="text-ink">请在下方任意一张图上点击一根 K 线，页面会回到那根 K 线收盘时的状态。</span>
            <button className="chip !py-0.5 !text-xs" onClick={() => onPicking(false)}>取消</button>
          </>
        ) : (
          <>
            <span className="text-ink-3">回到过去，看看当时的结论后来对不对：</span>
            {jumps.map((j) => (
              <button key={j.label} className="chip !py-0.5 !text-xs" onClick={() => onAsOf(j.t)}>
                {j.label}
              </button>
            ))}
            <button className="chip !py-0.5 !text-xs" onClick={() => onPicking(true)}>在图上选一根</button>
          </>
        )}
      </div>
    );
  }

  const r = data?.replay;
  const o = r?.outcome;
  const prev = data && data.candles.length > 2 ? data.candles[data.candles.length - 2].t : null;
  const next = r && r.future.length > 1 ? r.future[0].t : null;
  const verdictWord = data?.verdict.lightText;

  return (
    <div className="space-y-2 rounded-xl border border-warn/60 bg-warn-soft p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">🕰 正在回放</span>
        <span className="num text-ink" suppressHydrationWarning>
          {when(asOf)}
        </span>
        <span className="text-ink-2">{TF_LABEL[tf]} K 线收盘时的分析</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <button className="chip !py-0.5 !text-xs" disabled={!prev} onClick={() => prev && onAsOf(prev)}>◀ 前一根</button>
          <button className="chip !py-0.5 !text-xs" disabled={!next} onClick={() => next && onAsOf(next)}>后一根 ▶</button>
          <button className="chip !py-0.5 !text-xs" onClick={() => onPicking(true)}>重新选择</button>
          <button className="rounded-full bg-ink px-3 py-0.5 text-xs font-medium text-bg" onClick={() => onAsOf(null)}>回到现在</button>
        </span>
      </div>
      {picking && <p className="text-ink">请在下方图上点击一根 K 线。</p>}
      {error && <p className="text-down">{error}</p>}
      {data && r && (
        <p className="leading-relaxed text-ink-2">
          {o ? (
            <>
              之后 {o.horizonText}实际走势：收盘 <b className="num" style={{ color: o.closePct >= 0 ? "var(--up)" : "var(--down)" }}>{fmtPct(o.closePct)}</b>，最高 <span className="num">{fmtPct(o.maxPct)}</span>，最低 <span className="num">{fmtPct(o.minPct)}</span>。 当时的结论是「{verdictWord}」
              {o.correct == null ? (data.verdict.light === "yellow" ? "，观望不判断对错" : "，后面的 K 线还不够，暂时无法判断对错") : o.correct ? <b className="text-up">，✓ 后来证明判断正确</b> : <b className="text-down">，✗ 后来证明判断错了</b>}
              {o.stopHit != null && (o.stopHit ? "，认错位被触及过" : "，认错位没有被触及")}。
            </>
          ) : (
            "这根 K 线之后还没有新的数据。"
          )}
          <span className="block text-[11px] text-ink-3">回放时所有结论、关键位、信号和胜率都只用当时能看到的数据计算；图上灰色的 K 线是之后实际发生的走势。</span>
        </p>
      )}
    </div>
  );
}
