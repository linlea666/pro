"use client";

import { useState } from "react";
import type { Level } from "@/lib/ta/levels";
import type { SignalStats } from "@/lib/ta/stats";
import { TF_LABEL, type Timeframe } from "@/lib/types";
import { LightPill } from "../Light";
import { Term } from "../Term";
import { Explain } from "../Explain";
import { fmtPct, fmtPrice } from "./format";

export function Section({ title, extra, children, className = "" }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card p-4 ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {extra && <div className="ml-auto">{extra}</div>}
      </div>
      {children}
    </section>
  );
}

/** "3 分钟看懂" collapsible lesson attached to each method. */
export function Explainer({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-accent/30 bg-accent-soft">
      <button className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span aria-hidden="true">📘</span>
        <span className="font-medium">{title}</span>
        <span className="ml-auto text-ink-3">{open ? "收起" : "展开"}</span>
      </button>
      {open && <div className="space-y-2 px-4 pb-4 text-[13px] leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

const RELIABILITY_STYLE: Record<SignalStats["reliability"], { color: string; icon: string }> = {
  靠谱: { color: "var(--up)", icon: "✓" },
  一般: { color: "var(--warn)", icon: "~" },
  不靠谱: { color: "var(--down)", icon: "✗" },
  样本不足: { color: "var(--text-3)", icon: "?" },
};

export function ReliabilityBadge({ r }: { r: SignalStats["reliability"] }) {
  const s = RELIABILITY_STYLE[r];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ color: s.color, borderColor: s.color }}>
      <span aria-hidden="true">{s.icon}</span>
      {r}
    </span>
  );
}

/** Win-rate bar against the random baseline. */
function WinBar({ win, base }: { win: number | null; base: number }) {
  return (
    <div className="relative h-2 w-full rounded-full bg-panel-2" aria-hidden="true">
      {win != null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${win}%`, background: win >= base ? "var(--up)" : "var(--down)" }} />}
      <div className="absolute -inset-y-1 w-0.5 rounded bg-ink-2" style={{ left: `${base}%` }} title={`随机 ${base}%`} />
    </div>
  );
}

const STAT_TERM: Record<string, string> = {
  td_buy9: "Setup9",
  td_sell9: "Setup9",
  td_buy13: "Countdown13",
  td_sell13: "Countdown13",
  ema_golden: "金叉",
  ema_death: "金叉",
  rsi_oversold: "RSI",
  rsi_overbought: "RSI",
  reso_bull: "共振",
  reso_bear: "共振",
};

export function StatsTable({ stats, horizonText, coin, tf, only }: { stats: SignalStats[]; horizonText: string; coin: string; tf: Timeframe; only?: string[] }) {
  const rows = only ? stats.filter((s) => only.includes(s.key)) : stats;
  return (
    <div>
      <p className="mb-3 text-xs leading-relaxed text-ink-3">
        统计范围：{coin} {TF_LABEL[tf]}最近约 2000 根 K 线。“对”的意思是：看多信号出现 {horizonText}后价格更高，看空信号出现后价格更低。竖线表示随便找个时间点的<Term k="胜率">随机胜率</Term>，信号要明显超过它才有用。
      </p>
      <div className="space-y-3">
        {rows.map((s) => (
          <div key={s.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-2 text-sm">
              <span style={{ color: s.side === "bull" ? "var(--up)" : "var(--down)" }} aria-hidden="true">{s.side === "bull" ? "↑" : "↓"}</span>
              <Explain k={STAT_TERM[s.key] ?? "胜率"} variant="term">{s.name}</Explain>
              <span className="text-[11px] text-ink-3">{s.samples} 次</span>
            </div>
            <ReliabilityBadge r={s.reliability} />
            <div className="col-span-2">
              <WinBar win={s.winRate} base={s.baseWinRate} />
              <div className="num mt-1 text-xs text-ink-2">
                {s.winRate == null ? (
                  "暂无样本"
                ) : (
                  <>
                    对的比例 <b className="text-ink">{s.winRate}%</b>（随机 {s.baseWinRate}%）· 按信号操作平均{(s.avgReturn ?? 0) >= 0 ? "赚" : "亏"}{" "}
                    <b style={{ color: (s.avgReturn ?? 0) >= 0 ? "var(--up)" : "var(--down)" }}>{Math.abs(s.avgReturn ?? 0).toFixed(1)}%</b>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LevelsList({ supports, resistances, price, mode, onHover }: { supports: Level[]; resistances: Level[]; price: number; mode: "beginner" | "pro"; onHover?: (p: number | null) => void }) {
  const row = (l: Level) => (
    <li
      key={`${l.side}${l.price}`}
      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-panel-2"
      onMouseEnter={() => onHover?.(l.price)}
      onMouseLeave={() => onHover?.(null)}
    >
      <span className="w-12 text-xs" style={{ color: l.side === "support" ? "var(--up)" : "var(--down)" }}>
        {l.side === "support" ? "↓ 支撑" : "↑ 阻力"}
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="num font-medium">{fmtPrice(l.price)}</span>
          <span className="num text-xs text-ink-3">{fmtPct(l.distancePct, 1)}</span>
        </div>
        <div className="truncate text-[11px] text-ink-3" title={l.labels.join("、")}>
          {mode === "pro"
            ? `方法 ${l.methods.length} · 贡献 ${l.contributions} · ${l.timeframes.map((t) => TF_LABEL[t]).join("/")}`
            : `${l.methods.length} 种方法同时指向这里 · ${l.timeframes.map((t) => TF_LABEL[t]).join("/")}`}
        </div>
        <MethodChips level={l} max={mode === "pro" ? 4 : 2} small />
      </div>
      <Strength v={l.strength} />
    </li>
  );
  return (
    <div>
      <ul className="space-y-0.5">{[...resistances].reverse().map(row)}</ul>
      <div className="my-1.5 flex items-center gap-2 px-2 text-xs text-ink-2">
        <span className="h-px flex-1 bg-line" />
        现价 <b className="num text-ink">{fmtPrice(price)}</b>
        <span className="h-px flex-1 bg-line" />
      </div>
      <ul className="space-y-0.5">{supports.map(row)}</ul>
    </div>
  );
}

/** Clickable method badges for a level; each opens the method's explanation. */
export function MethodChips({ level, max = 3, small = false }: { level: Level; max?: number; small?: boolean }) {
  return (
    <div className={`flex flex-wrap gap-1 ${small ? "mt-1" : "mt-1.5"}`}>
      {level.methodIds.slice(0, max).map((id, k) => (
        <Explain
          key={id}
          k={`lvl:${id}`}
          variant="plain"
          className={`rounded border border-line px-1.5 ${small ? "py-0 text-[10px]" : "py-0.5 text-[11px]"} text-ink-2 hover:border-ink-3 hover:text-ink`}
          now={
            <>
              这个价位（{fmtPrice(level.price)}，距现价 {fmtPct(level.distancePct, 1)}）由 {(level.labelsByMethod[id] ?? []).join("、")} 给出，同时还有 {level.methods.length - 1} 种其他方法指向这里。
            </>
          }
        >
          {k === 0 ? "★ " : ""}
          {level.methods[k]}
        </Explain>
      ))}
      {level.methodIds.length > max && <span className={`${small ? "text-[10px]" : "text-[11px]"} text-ink-3`}>+{level.methodIds.length - max}</span>}
    </div>
  );
}

export function Strength({ v }: { v: number }) {
  const bars = v >= 75 ? 3 : v >= 45 ? 2 : 1;
  return (
    <span className="inline-flex items-end gap-0.5" title={`强度 ${v}/100`} aria-label={`强度 ${["弱", "中", "强"][bars - 1]}`}>
      {[1, 2, 3].map((k) => (
        <span key={k} className="w-1 rounded-sm" style={{ height: 4 + k * 3, background: k <= bars ? "var(--text-2)" : "var(--border)" }} />
      ))}
      <span className="ml-1 text-[11px] text-ink-3">{["弱", "中", "强"][bars - 1]}</span>
    </span>
  );
}

export { LightPill };
