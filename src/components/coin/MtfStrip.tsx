"use client";

import type { LightSummary } from "@/lib/analysis";
import { HIGHER_TF, TF_HORIZON, TF_LABEL, type Timeframe } from "@/lib/types";
import { fmtPct } from "./format";
import { useReplay } from "./replay";

/**
 * "多周期一览": one row of cells, one per timeframe, showing a single module's
 * state, plus a sentence comparing big and small timeframes.
 */

export type Tone = "up" | "down" | "warn" | "neutral";
export type MtfKind = "light" | "td" | "indicators" | "levels" | "trend" | "fib" | "chan";

interface Cell {
  main: string;
  sub: string;
  tone: Tone;
}

const TONE: Record<Tone, { color: string; soft: string; icon: string }> = {
  up: { color: "var(--up)", soft: "var(--up-soft)", icon: "↑" },
  down: { color: "var(--down)", soft: "var(--down-soft)", icon: "↓" },
  warn: { color: "var(--warn)", soft: "var(--warn-soft)", icon: "!" },
  neutral: { color: "var(--text-2)", soft: "var(--panel-2)", icon: "→" },
};

const sign = (v: number, band = 0): Tone => (v > band ? "up" : v < -band ? "down" : "neutral");

function cellFor(kind: MtfKind, m: LightSummary): Cell {
  switch (kind) {
    case "light":
      return { main: m.lightText, sub: m.trend, tone: m.light === "green" ? "up" : m.light === "red" ? "down" : "warn" };
    case "trend":
      return { main: m.trend, sub: `强度 ${m.trendScore > 0 ? "+" : ""}${m.trendScore}`, tone: sign(m.trendScore, 14) };
    case "indicators": {
      const net = m.votes.bull - m.votes.bear;
      return { main: `净 ${net > 0 ? "+" : ""}${net}`, sub: `${m.votes.bull}多 ${m.votes.bear}空`, tone: sign(net, 3) };
    }
    case "td": {
      const d = m.tdDetail;
      const fresh = d.last && !d.last.invalidated && d.last.barsAgo <= (d.last.kind === "setup9" ? 4 : 8);
      if (fresh) {
        const buy = d.last!.side === "buy";
        return { main: `${buy ? "跌势" : "涨势"}${d.last!.kind === "setup9" ? "9" : "13"}`, sub: `${d.last!.barsAgo} 根前`, tone: buy ? "down" : "up" };
      }
      const sub = d.countdown && d.countdown.count > 0 ? `计数 ${d.countdown.count}/${d.countdownLength}` : d.last ? `上次${d.last.side === "buy" ? "跌势" : "涨势"}${d.last.kind === "setup9" ? "9" : "13"}` : "—";
      const near = d.setupSide && d.setupCount >= d.setupLength - 2 && d.setupCount <= d.setupLength;
      return { main: d.setupSide ? `${d.setupSide === "buy" ? "跌" : "涨"} ${Math.min(d.setupCount, d.setupLength)}/${d.setupLength}` : "未计数", sub, tone: near || (d.countdown?.count ?? 0) >= d.countdownLength - 2 ? "warn" : "neutral" };
    }
    case "levels": {
      if (!m.s1 || !m.r1) return { main: m.s1 ? `撑 ${fmtPct(m.s1.distancePct, 1)}` : m.r1 ? `阻 ${fmtPct(m.r1.distancePct, 1)}` : "—", sub: "", tone: "neutral" };
      const ds = Math.abs(m.s1.distancePct), dr = Math.abs(m.r1.distancePct);
      return { main: `撑 ${fmtPct(m.s1.distancePct, 1)}`, sub: `阻 ${fmtPct(m.r1.distancePct, 1)}`, tone: ds < dr * 0.6 ? "up" : dr < ds * 0.6 ? "down" : "neutral" };
    }
    case "fib": {
      if (!m.fib) return { main: "—", sub: "", tone: "neutral" };
      const r = m.fib.ratio;
      const up = m.fib.direction === "up";
      const main = r < 0 ? "突破延伸" : r > 1 ? "完全回吐" : `回撤 ${Math.round(r * 100)}%`;
      const tone: Tone = r >= 0.382 && r <= 0.618 ? "warn" : r > 0.786 ? (up ? "down" : "up") : up ? "up" : "down";
      return { main, sub: up ? "上涨段" : "下跌段", tone };
    }
    case "chan": {
      const pos = m.chan.pos === "above" ? "中枢上方" : m.chan.pos === "below" ? "中枢下方" : m.chan.pos === "inside" ? "中枢内" : "—";
      if (!m.chan.last) return { main: "无买卖点", sub: pos, tone: m.chan.pos === "above" ? "up" : m.chan.pos === "below" ? "down" : "neutral" };
      const buy = m.chan.last.type.endsWith("买");
      return { main: `${m.chan.last.type}`, sub: `${m.chan.last.barsAgo} 根前 · ${pos}`, tone: buy ? "up" : "down" };
    }
  }
}

const SUBJECT: Record<MtfKind, string> = {
  light: "综合结论",
  td: "TD 时机",
  indicators: "指标投票",
  levels: "所处位置",
  trend: "趋势",
  fib: "回调程度",
  chan: "缠论结构",
};

function summarize(kind: MtfKind, mtf: LightSummary[], current: Timeframe): string {
  if (kind === "td") {
    const near = mtf.filter((m) => {
      const d = m.tdDetail;
      return (d.setupSide && d.setupCount >= d.setupLength - 2 && d.setupCount <= d.setupLength) || (d.countdown?.count ?? 0) >= d.countdownLength - 2;
    });
    if (near.length >= 2) return `${near.map((m) => TF_LABEL[m.tf]).join("、")} 同时接近 9 或 13。研究里（E25）几个周期同时出现也没有比单个周期更灵，只当作描述。`;
    if (near.length === 1) return `只有 ${TF_LABEL[near[0].tf]} 接近 9 或 13。`;
    return "各周期都没有接近 9 或 13，目前没有明显的时机信号。";
  }
  if (kind === "fib") {
    const zone = mtf.filter((m) => m.fib && m.fib.ratio >= 0.382 && m.fib.ratio <= 0.618);
    if (zone.length) return `${zone.map((m) => TF_LABEL[m.tf]).join("、")} 正处于 38.2%–61.8% 的常见回调区，是很多人关注的观察位置。`;
  }
  // the timeframe being viewed is the one that matches the holding time; the next one up only filters the direction
  const main = mtf.find((m) => m.tf === current);
  const filter = mtf.find((m) => m.tf === HIGHER_TF[current]);
  const s = SUBJECT[kind];
  if (!main) return "";
  const word = (t: string) => (t === "up" ? "偏多" : t === "down" ? "偏空" : "方向不明");
  const m = cellFor(kind, main).tone;
  const M = TF_LABEL[main.tf];
  if (!filter) return m === "neutral" ? `${s}在${M}上方向不明，先观望。` : `${s}在${M}上${word(m)}；${M}已经是最大的周期，没有更上一级可以对照。`;
  const f = cellFor(kind, filter).tone;
  const F = TF_LABEL[filter.tf];
  const why = `听${M}的，因为它对应你选的持有时间（${TF_HORIZON[main.tf]}）；${F}只用来看是不是顺着大方向。`;
  if (m === "neutral") return `${s}在${M}上方向不明，先观望；上一级${F}${word(f)}，可以作为之后的参考方向。`;
  if (f === m) return `${s}在${M}上${word(m)}，上一级${F}也${word(f)}，方向一致。${why}`;
  if (f === "neutral") return `${s}在${M}上${word(m)}，上一级${F}方向不明，没有大方向撑腰，持有时间别拖长。${why}`;
  return m === "up"
    ? `${s}在${M}上偏多，但上一级${F}偏空：这是逆着大方向的反弹，只适合短线、仓位要小，等${F}转强更稳。${why}`
    : `${s}在${M}上偏空，但上一级${F}偏多：这更可能只是大方向里的回调，不宜追空，等${F}也转弱再说。${why}`;
}

export function MtfStrip({ kind, mtf, current, onTf, title = "多周期一览" }: { kind: MtfKind; mtf: LightSummary[] | null; current: Timeframe; onTf?: (t: Timeframe) => void; title?: string }) {
  const replay = useReplay();
  if (replay?.asOf)
    return (
      <section className="card p-4">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-3">回放模式下只计算当前周期在那个时刻的状态，多周期一览暂不显示。</p>
      </section>
    );
  return (
    <section className="card p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <span className="ml-auto text-[11px] text-ink-3">点击切换周期</span>
      </div>
      {!mtf ? (
        <div className="h-20 animate-pulse rounded-lg bg-panel-2" />
      ) : (
        <>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${mtf.length}, minmax(0, 1fr))` }}>
            {mtf.map((m) => {
              const c = cellFor(kind, m);
              const t = TONE[c.tone];
              return (
                <button
                  key={m.tf}
                  onClick={() => onTf?.(m.tf)}
                  className="min-w-0 rounded-lg border px-1 py-2 text-center transition hover:brightness-110"
                  style={{ borderColor: m.tf === current ? t.color : "var(--border)", background: t.soft }}
                  aria-pressed={m.tf === current}
                >
                  <div className="text-[11px] text-ink-3">{TF_LABEL[m.tf]}</div>
                  <div className="mt-0.5 truncate text-[13px] font-semibold" style={{ color: t.color }}>
                    {c.tone !== "neutral" && <span aria-hidden="true">{t.icon}</span>}
                    {c.main}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-ink-3">{c.sub}</div>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-2">{summarize(kind, mtf, current)}</p>
        </>
      )}
    </section>
  );
}

