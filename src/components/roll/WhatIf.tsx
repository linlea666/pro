"use client";

import { useState } from "react";
import type { Account, Holding, HoldingView } from "@/lib/rollbook";
import { liqCheck, whatIfAdd } from "@/lib/ta/margin";
import { liquidationPrice, maxAdd, nextAddLevel, ROLL_RULES, trimQty, type Fill } from "@/lib/ta/roll";
import { fmtPrice } from "../coin/format";
import { bindingText, field, Kpi, money, toneColor } from "./ui";

/**
 * 加仓 / 补仓试算: add at a price, by margin, by quantity, or "move the average to …" (both on the winning
 * and on the losing side). Shows the margin it takes, the new average and liquidation (the exchange model for
 * a live position), the whole position at the stop against the risk budget, and the move back to break even.
 * On the winning side it also shows the rules' limit; on the losing side it says what the research found.
 */
export function WhatIf({ h, v, acc, onRecord }: { h: Holding; v: HoldingView; acc: Account; onRecord: ((f: Fill) => void) | null }) {
  const [by, setBy] = useState<"margin" | "qty" | "target">("margin");
  const [atIn, setAt] = useState(0);
  const [val, setVal] = useState(0);
  const [stopIn, setStop] = useState(0);
  const { pos, price } = v;
  if (!(pos.qty > 0) || price == null) return null;
  const losing = h.dir * (price - pos.avg) <= 0;
  const at = atIn > 0 ? atIn : +(v.addLevel ?? (losing ? price : nextAddLevel(h.dir, price, v.levels)) ?? price).toPrecision(6);
  const stop = stopIn > 0 ? stopIn : v.stop;
  const liqOf = v.liqOf ?? ((q: number, avg: number) => liquidationPrice({ dir: h.dir, qty: q, avg, mode: h.mode, leverage: h.leverage, account: acc.total }));
  const budget = acc.budget === "even" ? 0 : (acc.total * acc.riskPct) / 100;
  const gap = (v.atr ?? 0) * ROLL_RULES.liqGapAtr;
  // the rules' limit on the winning side (none on the losing side)
  const limit = stop != null && !losing ? maxAdd({ pos, price: at, stop, budget: v.budget, mode: h.mode, leverage: h.leverage, account: acc.total, atr: v.atr, fee: acc.fee, rules: v.rules, available: v.available, liqOf: v.liqOf }) : null;
  const typed = val > 0;
  const add = by === "target" ? (typed ? { target: val } : null) : { qty: typed ? (by === "qty" ? val : (val * h.leverage) / at) : (limit?.qty ?? 0) };
  const w = add ? whatIfAdd({ dir: h.dir, qty: pos.qty, avg: pos.avg, price: at, add, lever: h.leverage, fee: acc.fee, stop, equity: acc.total, available: v.available, budget, gap, liqOf }) : null;
  const exPos = h.ex && acc.snap ? acc.snap.positions.find((p) => p.key === h.ex!.key) : undefined;
  const check = exPos && acc.snap ? liqCheck(acc.snap, exPos) : null;
  const unit = h.dir > 0 ? "涨" : "跌";

  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="text-[15px] font-semibold">加仓 / 补仓试算</h3>
      <div className="flex flex-wrap gap-1.5">
        {(["margin", "qty", "target"] as const).map((k) => (
          <button key={k} className="chip" data-active={by === k} onClick={() => (setBy(k), setVal(0))}>
            {k === "margin" ? "按保证金" : k === "qty" ? "按数量" : "想把均价调到多少"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5 text-xs text-ink-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span>准备在什么价格加</span>
          <input id="wi-at" type="number" inputMode="decimal" className={field} value={atIn > 0 ? atIn : at || ""} onChange={(e) => setAt(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>{by === "margin" ? `加多少保证金 (USDT，${h.leverage}×)` : by === "qty" ? `加多少 ${h.coin}` : "加完想把均价调到"}</span>
          <input id="wi-val" type="number" inputMode="decimal" className={field} value={val || ""} placeholder={by === "target" ? (losing ? `比 ${fmtPrice(pos.avg)} ${h.dir > 0 ? "低" : "高"}` : `比 ${fmtPrice(pos.avg)} ${h.dir > 0 ? "高" : "低"}`) : limit && limit.qty > 0 ? "空着按规则上限" : ""} onChange={(e) => setVal(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>加完的止损</span>
          <input id="wi-stop" type="number" inputMode="decimal" className={field} value={stopIn > 0 ? stopIn : (v.stop ?? "")} onChange={(e) => setStop(+e.target.value)} />
        </label>
      </div>

      {losing ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs leading-relaxed text-ink-2">
          现在浮亏：按规则不加仓，下面只是把“拉低均价”算清楚。回测（E19）：在关键位直接接平均亏 0.3–0.45R；等 15 分钟转强再进好 0.44R，但本身仍不赚钱。亏损补仓（E47）还在回测，结果出来前这里不推荐补仓位置。补仓前先确定：止损不往外挪、补完打到止损仍在每笔风险以内、强平仍在止损之外。
        </p>
      ) : limit ? (
        <p className="text-sm">{limit.qty > 0 ? <>按规则最多加 <b className="num">{trimQty(limit.qty)}</b>（受“{bindingText(limit.binding, v.rules)}”限制）{!typed && by !== "target" ? "，下面按这个上限算。" : "。"}</> : <span className="text-warn">按规则这次不加：{bindingText(limit.binding, v.rules)}。</span>}</p>
      ) : (
        <p className="text-sm text-ink-3">先填止损，才能算按规则能加多少。</p>
      )}

      {by === "target" && typed && !w && <p className="text-sm text-down">在 {fmtPrice(at)} 加仓，均价只能落在现在的均价 {fmtPrice(pos.avg)} 和 {fmtPrice(at)} 之间，调不到 {fmtPrice(val)}。</p>}

      {w && (
        <>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <Kpi k="需要加" v={trimQty(w.qty)} sub={`保证金 ${w.margin.toFixed(1)} USDT`} />
            <Kpi k="加完均价" v={fmtPrice(w.avg)} sub={`共 ${trimQty(w.total)}`} />
            <Kpi k="加完强平" v={<span className={w.liqOk ? "" : "text-down"}>{fmtPrice(w.liq)}</span>} sub={check?.estimate ? `模型和交易所差 ${(check.diff! * 100).toFixed(1)}%，是估算` : h.ex ? "按交易所账户口径" : "按 0.5% 维持保证金率估算"} />
            <Kpi k="打到止损" v={<span className={toneColor(w.atStop ?? 0)}>{w.atStop != null ? money(w.atStop) : "—"}</span>} sub={w.atStopPct != null ? `权益的 ${w.atStopPct.toFixed(1)}%` : "没有止损"} />
            <Kpi k="回到均价" v={`${unit} ${Math.abs(w.toEven).toFixed(2)}%`} sub={`从 ${fmtPrice(at)} 到 ${fmtPrice(w.avg)}`} />
          </div>
          {w.problems.length ? (
            <ul className="space-y-0.5 text-sm text-down">{w.problems.map((p) => <li key={p}>✗ {p}</li>)}</ul>
          ) : (
            <p className="text-sm text-up">✓ 可用保证金够、打到止损在每笔风险（{Math.round(budget).toLocaleString("en-US")} USDT）以内、强平在止损之外。</p>
          )}
          {onRecord && (
            <button className="rounded-lg bg-ink px-3 py-1.5 text-sm text-bg" onClick={() => (onRecord({ kind: "add", price: at, qty: w.qty }), setVal(0))}>我按这个加了</button>
          )}
          {!onRecord && <p className="text-[11px] text-ink-3">在交易所下单后，这里一分钟内自动同步。</p>}
        </>
      )}
    </div>
  );
}
