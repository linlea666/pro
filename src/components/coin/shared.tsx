"use client";

import { useState } from "react";
import type { Level } from "@/lib/ta/levels";
import type { SignalStats } from "@/lib/ta/stats";
import { TF_LABEL, TIMEFRAMES, type Timeframe } from "@/lib/types";
import { LightPill } from "../Light";
import { Term } from "../Term";
import { Explain } from "../Explain";
import { fmtPct, fmtPrice } from "./format";
import { METHOD_FAMILY, familyStyle } from "./level-tags";

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
  证据较强: { color: "var(--up)", icon: "✓" },
  证据弱: { color: "var(--warn)", icon: "~" },
  历史上不利: { color: "var(--down)", icon: "✗" },
  证据不足: { color: "var(--text-3)", icon: "?" },
};

export function ReliabilityBadge({ r }: { r: SignalStats["reliability"] }) {
  // unknown labels (e.g. data from a newer server than this page's code) still render
  const s = RELIABILITY_STYLE[r] ?? { color: "var(--text-3)", icon: "?" };
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

/**
 * Arrow and colour for a signal row. Most signals point the way they bet; TD 9 / 13 instead show the run
 * that already happened (跌势 = red ↓), so a "TD 跌势 9" never reads as a green "buy".
 */
export function signalMark(key: string, side: "bull" | "bear"): { icon: string; color: string } {
  const up = key.startsWith("td_") ? side === "bear" : side === "bull";
  return { icon: up ? "↑" : "↓", color: up ? "var(--up)" : "var(--down)" };
}

export function StatsTable({ stats, horizonText, coin, tf, only }: { stats: SignalStats[]; horizonText: string; coin: string; tf: Timeframe; only?: string[] }) {
  const rows = only ? stats.filter((s) => only.includes(s.key)) : stats;
  return (
    <div>
      <p className="mb-3 text-xs leading-relaxed text-ink-3">
        统计范围：{coin} {TF_LABEL[tf]}最近约 2000 根已收盘的 K 线。“对”的意思是：看多信号出现 {horizonText}后价格更高，看空信号出现后价格更低，并且已扣除约 0.15% 的来回手续费和滑点。相隔太近的信号只算一次，避免同一段行情被重复计数。竖线表示随便找个时间点的<Term k="胜率">随机胜率</Term>。一页上同时检验几十个信号，总会有几个碰巧显得好，所以只有扣掉这种“碰巧”之后仍明显好于随机的，才标“证据较强”；大多数信号只能算“证据弱”。
      </p>
      <div className="space-y-3">
        {rows.map((s) => (
          <div key={s.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-2 text-sm">
              <span style={{ color: signalMark(s.key, s.side).color }} aria-hidden="true">{signalMark(s.key, s.side).icon}</span>
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
                    对的比例 <b className="text-ink">{s.winRate}%</b>
                    <span className="text-ink-3">（95% 区间 {s.winLo}–{s.winHi}%）</span>，随机 {s.baseWinRate}% · 扣除成本后平均{(s.avgReturn ?? 0) >= 0 ? "赚" : "亏"}{" "}
                    <b style={{ color: (s.avgReturn ?? 0) >= 0 ? "var(--up)" : "var(--down)" }}>{Math.abs(s.avgReturn ?? 0).toFixed(2)}%</b>
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
      className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-panel-2"
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
            ? `方法 ${l.methods.length} · 贡献 ${l.contributions} · ${tfsLargestFirst(l.timeframes).map((t) => TF_LABEL[t]).join("/")}`
            : `${l.methods.length} 种方法同时指向这里 · ${tfsLargestFirst(l.timeframes).map((t) => TF_LABEL[t]).join("/")}`}
        </div>
        <MethodChips level={l} max={mode === "pro" ? 4 : 2} small />
      </div>
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

/** Largest timeframe first: 周线 / 日线 / 4小时 / … */
export function tfsLargestFirst(tfs: Timeframe[]): Timeframe[] {
  return [...tfs].sort((a, b) => TIMEFRAMES.indexOf(b) - TIMEFRAMES.indexOf(a));
}

/**
 * Clickable method badges for a level, colored by method family; each opens the method's explanation and the
 * contributions it gave here. Methods past `max` hide behind a "还有 N 种" button.
 */
export function MethodChips({ level, max, small = false }: { level: Level; max?: number; small?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all || max == null ? level.methodIds : level.methodIds.slice(0, max);
  const hidden = level.methodIds.length - shown.length;
  const size = small ? "py-0 text-[10px]" : "py-0.5 text-[11px]";
  return (
    <div className={`flex flex-wrap items-center gap-1 ${small ? "mt-1" : "mt-1.5"}`}>
      {shown.map((id, k) => {
        const own = level.labelsByMethod[id] ?? [];
        return (
          <span key={id} title={k === 0 ? "★ 这个价位上贡献最多的方法" : undefined} className="inline-flex">
            <Explain
              k={`lvl:${id}`}
              variant="plain"
              className={`rounded border px-1.5 ${size} hover:brightness-125`}
              style={familyStyle(METHOD_FAMILY[id])}
              now={
                <>
                  这个价位（{fmtPrice(level.price)}，距现价 {fmtPct(level.distancePct, 1)}）上，{level.methods[k]}给了 {own.length} 条：{own.join("、")}。同时还有 {level.methods.length - 1} 种其他方法指向这里。
                </>
              }
            >
              {k === 0 ? "★ " : ""}
              {level.methods[k]}
              {own.length > 1 && <span className="num ml-1 opacity-70">×{own.length}</span>}
            </Explain>
          </span>
        );
      })}
      {hidden > 0 && (
        <button className={`rounded border border-dashed border-line px-1.5 ${size} text-ink-3 hover:text-ink`} onClick={() => setAll(true)}>
          还有 {hidden} 种
        </button>
      )}
      {all && max != null && level.methodIds.length > max && (
        <button className={`px-1 ${size} text-ink-3 hover:text-ink`} onClick={() => setAll(false)}>
          收起
        </button>
      )}
    </div>
  );
}

export { LightPill };
