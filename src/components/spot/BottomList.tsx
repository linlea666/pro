"use client";

import type { SpotPage } from "@/lib/spot/page";
import { BOTTOM_FACTS, type BottomItem, type BottomKey } from "@/lib/spot/bottoms";
import { Card, fmtSigned, fmtUsd, Fold, type Mode } from "./spot-ui";

const SHORT: Record<BottomKey, string> = {
  rsi30: "周线 RSI",
  wma200: "200 周均线",
  mvrv1: "MVRV",
  piBottom: "Pi Cycle",
  ma200: "200 日均线",
  week50: "50 周均线",
};

const YEARS: Record<number, string> = { 365: "1 年", 730: "2 年" };

function Dot({ lit }: { lit: boolean }) {
  return (
    <span
      aria-label={lit ? "已亮" : "没亮"}
      className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full border"
      style={lit ? { background: "var(--up)", borderColor: "var(--up)" } : { borderColor: "var(--border)" }}
    />
  );
}

function Row({ it, mode }: { it: BottomItem; mode: Mode }) {
  return (
    <li className="flex items-start gap-2 py-1.5">
      <Dot lit={it.lit} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">
          {it.label}
          {mode === "pro" && <span className="ml-1.5 text-[11px] text-ink-3">{it.kind}</span>}
        </div>
        <div className="num text-[12px] text-ink-3">
          {it.price != null ? (
            <>
              {it.value} {fmtUsd(it.price)}
              {it.distPct != null && !it.lit && <>，价格跌到这里才亮（离现价 {fmtSigned(it.distPct)}）</>}
              {it.lit && <>，价格已经在它下面</>}
            </>
          ) : (
            it.value
          )}
        </div>
      </div>
      <span className={`shrink-0 text-[12px] ${it.lit ? "font-medium text-up" : "text-ink-3"}`}>{it.lit ? "已亮" : "没亮"}</span>
    </li>
  );
}

/** The 见底清单: six bottom conditions bloggers cite, which are lit now, and what followed each past cycle's first "half lit" (E27). */
export function BottomListCard({ d, mode }: { d: SpotPage; mode: Mode }) {
  const b = d.bottoms;
  if (!b) return null;
  const half = d.bottomRules.half;
  const fd = b.furtherDrop;
  const hi = b.higher.filter((h) => h.n > 0);
  return (
    <Card title="见底清单" extra={`截至 ${b.day}（UTC 日线）`}>
      <p className="text-[15px] font-semibold leading-snug">
        常被拿来判断“见底”的 6 项里，现在亮了 {b.litCount} 项{b.litCount >= half ? `（已到一半）` : ""}。
      </p>
      <ul className="mt-2 divide-y divide-line">
        {b.items.map((it) => (
          <Row key={it.key} it={it} mode={mode} />
        ))}
      </ul>
      {fd && (
        <p className="mt-3 rounded-lg bg-panel-2 px-3 py-2 text-[13px] leading-relaxed text-ink">
          历史上每一轮第一次亮到 {half} 项之后（{b.from} 起可算，共 {fd.n} 轮），价格又跌了 {Math.abs(fd.min).toFixed(0)}%–{Math.abs(fd.max).toFixed(0)}%
          （中位 {Math.abs(fd.median).toFixed(0)}%）
          {hi.length > 0 && <>；{hi.map((h) => `${YEARS[h.days]}后 ${h.n} 轮里 ${h.up} 轮更高`).join("，")}</>}
          。亮灯说明价格进了便宜的区间，不说明已经到底：还可能更便宜，适合分批买，别一次买完。轮数太少，只作参考。
        </p>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{BOTTOM_FACTS.same}</p>
      <div className="mt-2">
        <Fold key={mode} defaultOpen={mode === "pro"} label={["看每一轮", "收起每一轮"]}>
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="num w-full min-w-[560px] text-[12px]">
              <thead>
                <tr className="border-b border-line text-left text-ink-3">
                  <th className="py-1.5 pr-2 font-normal">第一次亮到 {half} 项</th>
                  <th className="py-1.5 pr-2 text-right font-normal">价格</th>
                  <th className="py-1.5 pr-2 font-normal">亮的是</th>
                  <th className="py-1.5 pr-2 text-right font-normal">之后 2 年内最深再跌</th>
                  {d.bottomRules.horizons.map((h) => (
                    <th key={h} className="py-1.5 pr-2 text-right font-normal">
                      {YEARS[h]}后
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {b.episodes.map((e) => (
                  <tr key={e.start}>
                    <td className="py-1.5 pr-2">{e.start}</td>
                    <td className="py-1.5 pr-2 text-right">{fmtUsd(e.price)}</td>
                    <td className="py-1.5 pr-2">{e.lit.map((k) => SHORT[k]).join("、")}</td>
                    <td className="py-1.5 pr-2 text-right">
                      {e.drawdownPct < 0 ? (
                        <>
                          <span className="text-down">{e.drawdownPct.toFixed(0)}%</span>
                          <span className="block text-[11px] text-ink-3">{e.lowDay}</span>
                        </>
                      ) : (
                        <span className="text-ink-3">没有再跌</span>
                      )}
                    </td>
                    {e.after.map((a) => (
                      <td key={a.days} className="py-1.5 pr-2 text-right">
                        {a.mult == null ? <span className="text-ink-3">未满</span> : <span style={{ color: a.mult > 1 ? "var(--up)" : "var(--down)" }}>{fmtSigned((a.mult - 1) * 100)}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Fold>
      </div>
      {mode === "pro" && (
        <ul className="mt-3 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-ink-3">
          <li>{BOTTOM_FACTS.rsi}</li>
          <li>{BOTTOM_FACTS.divergence}</li>
          <li>{BOTTOM_FACTS.missing}</li>
          <li>周线 RSI 和 50 周均线按“从今天往回每 7 天取一个收盘”计算，和 200 周均线一致；和交易所日历周线会差几天。</li>
        </ul>
      )}
    </Card>
  );
}
