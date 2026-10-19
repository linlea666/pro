"use client";

import { useState } from "react";
import type { LightSummary } from "@/lib/analysis";
import type { Level } from "@/lib/ta/levels";
import type { SignalStats } from "@/lib/ta/stats";
import { TF_LABEL, type Timeframe } from "@/lib/types";
import { LightPill, lightMeta } from "../Light";
import { Term } from "../Term";
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
              <span>{s.name}</span>
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
            ? `方法 ${l.methods.length} · 贡献 ${l.contributions} · ${l.methods.slice(0, 3).join(" / ")}`
            : `${l.methods.length} 种方法同时指向这里 · ${l.timeframes.map((t) => TF_LABEL[t]).join("/")}`}
        </div>
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

export function MtfMatrix({ mtf, current, onTf }: { mtf: LightSummary[] | null; current: Timeframe; onTf?: (t: Timeframe) => void }) {
  if (!mtf) return <div className="h-24 animate-pulse rounded-lg bg-panel-2" />;
  const greens = mtf.filter((m) => m.light === "green").length;
  const reds = mtf.filter((m) => m.light === "red").length;
  const summary =
    greens >= 4 ? "大小周期几乎都偏多，方向一致性很高。" : reds >= 4 ? "大小周期几乎都偏空，方向一致性很高。" : greens > reds ? "偏多的周期更多，但并非全部同向。" : reds > greens ? "偏空的周期更多，但并非全部同向。" : "各周期看法不一，整体方向不明朗。";
  return (
    <div>
      <div className="grid grid-cols-5 gap-1.5">
        {mtf.map((m) => {
          const meta = lightMeta(m.light);
          return (
            <button
              key={m.tf}
              onClick={() => onTf?.(m.tf)}
              className="min-w-0 rounded-lg border px-1 py-2 text-center transition hover:brightness-110"
              style={{ borderColor: m.tf === current ? meta.color : "var(--border)", background: meta.soft }}
            >
              <div className="text-[11px] text-ink-3">{TF_LABEL[m.tf]}</div>
              <div className="mt-0.5 whitespace-nowrap text-[13px] font-semibold sm:text-sm" style={{ color: meta.color }}>
                {meta.icon}
                {m.lightText}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-ink-3">{m.trend}</div>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-ink-2">{summary}</p>
    </div>
  );
}

export { LightPill };
