"use client";

import { useEffect, useState } from "react";
import type { PhaseAhead, PhaseRow, PhaseTf, WatchView } from "@/lib/watch";
import { MMR, sizePosition } from "@/lib/ta/plan";
import { Term } from "../Term";
import type { Mode } from "./CoinView";
import { fmtPrice } from "./format";
import { fmtWhen, readPref } from "./plan-ui";

/**
 * 行情阶段卡（实时盯盘页签顶部）：15 分钟 / 1 小时 / 4 小时各在“下跌中 → 止跌尝试 → 反弹 → 转强 → 上升中”的哪一格，
 * 还差哪一步、跌破哪里作废。阶段、句子和历史比例都来自服务端（src/lib/ta/phase.ts、src/lib/watch.ts），这里只排版。
 */

const TF_WORD: Record<PhaseTf, string> = { "15m": "15 分钟", "1h": "1 小时", "4h": "4 小时" };

/** cell tone: ① still going, ④ turned, the rest neutral; colour always comes with the cell's words */
const cellTone = (stage: number) => (stage === 1 ? "border-warn/60 bg-warn-soft text-warn" : stage === 4 ? "border-accent/60 bg-accent-soft text-accent" : "border-ink-3/60 bg-panel-2 text-ink");

/** The four checks of one row in words, with the prices that decide them. */
function checkLines(r: PhaseRow): { ok: boolean; name: string; detail: string }[] {
  const up = r.dir > 0;
  const x = up ? "低" : "高";
  const better = up ? "更高的低点" : "更低的高点";
  const bounce = up ? "反弹高点" : "回落低点";
  return [
    { ok: r.checks[0], name: `不再创新${x}`, detail: r.checks[0] ? `最${x} ${fmtPrice(r.low)}` : `还在创新${x}（最${x} ${fmtPrice(r.low)}）` },
    {
      ok: r.checks[1],
      name: `${x}点站住`,
      detail: r.checks[1] ? `${fmtPrice(r.low)} 之后已${up ? "反弹" : "回落"} 2 倍 ATR` : r.heldAt != null ? `要${up ? "反弹" : "回落"}到 ${fmtPrice(r.heldAt)}` : "还要先停下来",
    },
    {
      ok: r.checks[2],
      name: better,
      detail: r.checks[2] ? fmtPrice(r.higherLow) : r.candidate != null ? `${fmtPrice(r.candidate)} 可能是，还没确认` : "还没有",
    },
    { ok: r.checks[3], name: `收盘${up ? "站上" : "跌破"}${bounce}`, detail: r.checks[3] ? `已${up ? "站上" : "跌破"} ${fmtPrice(r.bounce)}` : `收盘要${up ? "高" : "低"}于 ${fmtPrice(r.trigger)}` },
  ];
}

/** two-character names for phone widths: 下跌中 → 下跌, 止跌尝试 → 止跌 */
const short = (name: string) => name.replace(/(中|尝试)$/, "");

function Ladder({ r, selected, onSelect }: { r: PhaseRow; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`grid w-full grid-cols-[3.4rem_repeat(5,minmax(0,1fr))] items-center gap-1 rounded-lg p-1 text-left sm:grid-cols-[4.5rem_repeat(5,minmax(0,1fr))] sm:gap-1.5 ${selected ? "bg-panel-2 ring-1 ring-line" : "hover:bg-panel-2/60"}`}
    >
      <span className="text-[12px] font-medium sm:text-[13px]">{TF_WORD[r.tf]}</span>
      {r.names.map((name, k) => {
        const here = k === r.stage - 1;
        return (
          <span
            key={k}
            className={`truncate rounded-md border px-0.5 py-1.5 text-center text-[11px] sm:text-[12px] ${here ? `font-semibold ${cellTone(r.stage)}` : k === 4 ? "border-dashed border-line text-ink-3" : "border-line text-ink-3"}`}
            title={here ? `现在：${name}` : name}
          >
            <span className="hidden sm:inline">
              {"①②③④⑤"[k]} {name}
            </span>
            <span className="sm:hidden">{short(name)}</span>
          </span>
        );
      })}
    </button>
  );
}

export function PhaseCard({ v, mode }: { v: WatchView; mode: Mode }) {
  const ph = v.phases;
  const [sel, setSel] = useState<PhaseTf>("1h");
  if (!ph) return null;
  const rows = ph.rows;
  const r = rows.find((x) => x.tf === sel) ?? rows.find((x) => x.tf === "1h")!;
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-[15px] font-semibold">行情阶段</h2>
        <span className="text-xs text-ink-3">只按已收盘的 K 线；三个周期各算各的，不合成一个分数</span>
      </div>
      <p className="mt-2 text-[15px] font-medium leading-relaxed">{ph.headline}</p>

      <div className="mt-3 space-y-1">
        {rows.map((x) => (
          <Ladder key={x.tf} r={x} selected={x.tf === r.tf} onSelect={() => setSel(x.tf)} />
        ))}
      </div>
      <p className="mt-1 text-[11px] text-ink-3">点一行看它还缺什么。最后一格是终点：结构已经判定为反方向的趋势，之后梯子换到另一边。</p>

      <div className="mt-3 rounded-lg border border-line p-3">
        <div className="text-[13px] font-medium">
          {TF_WORD[r.tf]}：{r.names[r.stage - 1]}
          <span className="ml-1 font-normal text-ink-3">（{r.dir > 0 ? "从下跌往上修复" : "从上涨往下转弱"}）</span>
        </div>
        <ul className="mt-2 grid gap-1 text-[13px] sm:grid-cols-2">
          {checkLines(r).map((c) => (
            <li key={c.name} className="flex items-baseline gap-1.5">
              <span className={c.ok ? "text-accent" : "text-ink-3"} aria-label={c.ok ? "已满足" : "还差"}>
                {c.ok ? "✓" : "○"}
              </span>
              <span className={c.ok ? "text-ink" : "text-ink-2"}>{c.name}</span>
              <span className="num text-[12px] text-ink-3">{c.detail}</span>
            </li>
          ))}
        </ul>
        {r.stage > 1 && (
          <p className="mt-2 text-[13px] text-down">
            作废：收盘{r.dir > 0 ? "跌破" : "涨破"} <b className="num">{fmtPrice(r.invalid)}</b> 就回到“{r.names[0]}”，这条线不跟着往下挪。
          </p>
        )}
        {r.fact && <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{r.fact}</p>}
        {mode === "pro" && (
          <p className="num mt-1 text-[11px] text-ink-3">
            ATR {fmtPrice(r.atr)}；摆动点按 2 倍 ATR 确认；收盘越过 0.1 倍 ATR 才算站上 / 跌破。
          </p>
        )}
      </div>

      {ph.leg && ph.leg.through.length > 0 && (
        <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] leading-relaxed text-ink">
          这一段从 <b className="num">{fmtPrice(ph.leg.from)}</b> {ph.leg.dir > 0 ? "跌到" : "涨到"} <b className="num">{fmtPrice(ph.leg.extreme)}</b>，已经收盘
          {ph.leg.dir > 0 ? "跌穿" : "涨过"} {ph.leg.through.length} 个关键位（{ph.leg.through.map((x) => `${x.name} ${fmtPrice(x.price)}`).join("、")}）。
          {ph.leg.dir > 0
            ? "下一个关键位到了也不是加仓的理由：先等 15 分钟转强。"
            : "下一个关键位到了也不是加空的理由：先等 15 分钟转弱。"}
        </p>
      )}

      {ph.ahead && <AheadBox a={ph.ahead} />}

      {ph.early && (
        <div className="mt-3 rounded-lg border border-accent/40 px-3 py-2 text-[13px] leading-relaxed">
          <div className="font-medium text-accent">
            早提示：细一级的 15 分钟结构已{ph.early.dir > 0 ? "转强" : "转弱"}
            <span className="num ml-1 font-normal text-ink-3">
              （{fmtWhen(ph.early.t + 900)} 收盘 {fmtPrice(ph.early.price)}，止损约 {fmtPrice(ph.early.stop)}）
            </span>
          </div>
          <p className="mt-1 text-[12px] text-ink-2">{ph.early.text}</p>
        </div>
      )}
    </section>
  );
}

/** Before the turn: the price that would make it, the stop it would use, and what that risk allows. */
function AheadBox({ a }: { a: PhaseAhead }) {
  const [pref, setPref] = useState({ capital: 1000, risk: 1, lev: 5 });
  useEffect(() => setPref({ capital: readPref("capital", 1000), risk: readPref("risk", 1), lev: readPref("lev", 5) }), []);
  const up = a.dir > 0;
  const better = up ? "更高的低点" : "更低的高点";
  const valid = up ? a.stop < a.trigger : a.stop > a.trigger;
  const r = valid ? sizePosition({ capital: pref.capital, riskPct: pref.risk, entry: a.trigger, stop: a.stop, leverage: pref.lev }) : null;
  const what = a.closedPast
    ? `已经收盘${up ? "站上" : "跌破"} ${fmtPrice(a.trigger)}，还差一个${better}`
    : `${a.haveBetter ? `${better}已经有了，` : `先走出${better}，再 `}15 分钟收盘${up ? "站上" : "跌破"} ${fmtPrice(a.trigger)}`;
  return (
    <div className="mt-3 rounded-lg bg-panel-2 px-3 py-2 text-[13px] leading-relaxed">
      <div>
        还没<Term k="转强">{up ? "转强" : "转弱"}</Term>，条件已经知道：{what}；那时止损约 <b className="num">{fmtPrice(a.stop)}</b>
        <span className="text-ink-3">（离 {fmtPrice(a.trigger)} 有 {((Math.abs(a.trigger - a.stop) / a.trigger) * 100).toFixed(2)}%）</span>。
      </div>
      {r && (
        <div className="mt-0.5 text-ink-2">
          按资金 {pref.capital} USDT、每笔最多亏 {pref.risk}%（和计划页、盯盘的仓位计算器同一套设置）：仓位价值约{" "}
          <b className="num">{r.notional.toLocaleString("en-US", { maximumFractionDigits: 0 })}</b> USDT，{pref.lev} 倍杠杆保证金约{" "}
          <span className="num">{r.margin.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span> USDT。
          {!r.stopBeforeLiq && <span className="text-down"> 强平价在止损之前，降低杠杆。</span>}
        </div>
      )}
      <p className="mt-0.5 text-[11px] text-ink-3">
        以收盘为准。盘中碰到就成交的条件单和等收盘结果差不多（E33），但它不会替你检查“先有{better}”。强平按逐仓、维持保证金率 {MMR * 100}% 粗算。
      </p>
    </div>
  );
}
