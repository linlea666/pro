"use client";

import type { Holding, HoldingView } from "@/lib/rollbook";
import { trimQty } from "@/lib/ta/roll";
import { fmtPrice } from "../coin/format";
import { money, severity, toneColor, TONE_TEXT } from "./ui";

/**
 * Every position of the account in one table, most urgent first: what it is, what it makes, whether a
 * stop order protects it, how far liquidation is, and what to do now. A row opens its details.
 */
export function PositionTable({ views, picked, onPick }: { views: (readonly [Holding, HoldingView])[]; picked: string | null; onPick: (id: string) => void }) {
  if (!views.length) return null;
  const rows = [...views].sort(([, a], [, b]) => severity(a) - severity(b) || openOf(a, b) );
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="num w-full min-w-[720px] text-sm">
        <thead className="bg-panel-2 text-left text-xs text-ink-3">
          <tr>
            <th className="px-3 py-2 font-medium">持仓</th>
            <th className="px-3 py-2 text-right font-medium">浮动盈亏</th>
            <th className="px-3 py-2 font-medium">止损</th>
            <th className="px-3 py-2 text-right font-medium">离强平</th>
            <th className="px-3 py-2 font-medium">现在</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([h, v]) => {
            const upl = h.ex ? h.ex.upl : (v.open ?? 0);
            const liqPct = v.liq != null && v.price != null ? (h.dir * (v.price - v.liq) / v.price) * 100 : null;
            return (
              <tr key={h.id} className={`cursor-pointer border-t border-line hover:bg-panel-2 ${picked === h.id ? "bg-accent-soft" : ""}`} onClick={() => onPick(h.id)}>
                <td className="px-3 py-2">
                  <b>{h.coin}</b> <span className={h.dir > 0 ? "text-up" : "text-down"}>{h.dir > 0 ? "多" : "空"}</span>
                  <span className="text-ink-3"> · {h.mode === "isolated" ? "逐仓" : "全仓"} {h.leverage}×</span>
                  <span className="block text-xs text-ink-3">{trimQty(v.pos.qty)} · 均价 {fmtPrice(v.pos.avg)}{h.ex && !h.ex.listed ? " · 只做风险检查" : ""}</span>
                </td>
                <td className={`px-3 py-2 text-right ${toneColor(upl)}`}>{money(upl)}</td>
                <td className="px-3 py-2">
                  {v.guard ? (
                    v.guard.state === "ok" ? <span className="text-up">{fmtPrice(v.stop)}</span> : <span className="text-down">{v.guard.state === "none" ? "没有止损单" : v.guard.state === "beyondLiq" ? "在强平后面" : "只覆盖一部分"}</span>
                  ) : v.stop != null ? (
                    fmtPrice(v.stop)
                  ) : (
                    <span className="text-warn">没填</span>
                  )}
                </td>
                <td className={`px-3 py-2 text-right ${liqPct != null && liqPct < 5 ? "text-down" : ""}`}>{liqPct != null ? `${liqPct.toFixed(1)}%` : "—"}</td>
                <td className={`px-3 py-2 ${v.status ? TONE_TEXT[v.status.tone] : ""}`}>{v.status?.title ?? "行情加载中"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** bigger losses first among equals */
const openOf = (a: HoldingView, b: HoldingView) => (a.open ?? 0) - (b.open ?? 0);
