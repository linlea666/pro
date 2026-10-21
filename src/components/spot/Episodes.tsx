"use client";

import type { SpotPage } from "@/lib/spot/page";
import type { EpisodeHorizon, EpisodeResult } from "@/lib/spot/valuation";
import { Card, fmtDays, fmtSpan, fmtUsd, Fold, type Mode } from "./spot-ui";

const YEARS: Record<number, string> = { 365: "1 年", 730: "2 年", 1460: "4 年" };

const mult = (v: number) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));

function HorizonCell({ h }: { h: EpisodeHorizon }) {
  if (h.mult == null || h.base == null) return <span className="text-ink-3">未满</span>;
  const better = h.mult > h.base;
  return (
    <span className="whitespace-nowrap">
      <b style={{ color: better ? "var(--up)" : "var(--down)" }}>{mult(h.mult)}×</b>
      <span className="text-ink-3"> / {mult(h.base)}×</span>
    </span>
  );
}

function Summary({ e }: { e: EpisodeResult }) {
  return (
    <ul className="num space-y-0.5 text-[12px] leading-relaxed text-ink-2">
      {e.summary.map((s) => (
        <li key={s.days}>
          <b className="text-ink">{YEARS[s.days] ?? `${s.days} 天`}后</b>：
          {s.n === 0 ? (
            "还没有一段满这么久"
          ) : (
            <>
              {s.n} 段里 {s.better} 段好于同期
              {s.ratio != null && <span className="text-ink-3">（平均是同期的 {s.ratio.toFixed(2)} 倍）</span>}；{s.verdict}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function Table({ e }: { e: EpisodeResult }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="num w-full min-w-[640px] text-[12px]">
        <thead>
          <tr className="border-b border-line text-left text-ink-3">
            <th className="py-1.5 pr-2 font-normal">起止（天数）</th>
            <th className="py-1.5 pr-2 text-right font-normal">进入价</th>
            <th className="py-1.5 pr-2 text-right font-normal">之后最深再跌</th>
            <th className="py-1.5 pr-2 text-right font-normal">回到进入价</th>
            {e.rows[0]?.horizons.map((h) => (
              <th key={h.days} className="py-1.5 pr-2 text-right font-normal">
                {YEARS[h.days]}：本段 / 同期
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {e.rows.map((r) => (
            <tr key={r.start}>
              <td className="py-1.5 pr-2">
                {fmtSpan(r.start, r.end)} <span className="text-ink-3">（{r.days}）</span>
              </td>
              <td className="py-1.5 pr-2 text-right">{fmtUsd(r.entry)}</td>
              <td className="py-1.5 pr-2 text-right">
                {r.drawdownPct < 0 ? (
                  <>
                    <span className="text-down">{r.drawdownPct.toFixed(0)}%</span>
                    <span className="block text-[11px] text-ink-3">{r.lowDay}</span>
                  </>
                ) : (
                  <span className="text-ink-3">没有再跌</span>
                )}
              </td>
              <td className="py-1.5 pr-2 text-right">{r.recoverDays == null ? <span className="text-ink-3">至今没回到</span> : fmtDays(r.recoverDays)}</td>
              {r.horizons.map((h) => (
                <td key={h.days} className="py-1.5 pr-2 text-right">
                  <HorizonCell h={h} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** ⑦ Every past episode of each zone, listed one by one (there are only a handful), with the summary per horizon. */
export function Episodes({ d, mode }: { d: SpotPage; mode: Mode }) {
  const keys = ["mvrv1", "wma", "fear", ...(mode === "pro" ? ["mvrvHigh"] : [])];
  const list = keys.map((k) => d.episodes.find((e) => e.zone.key === k)).filter((e): e is EpisodeResult => !!e && e.rows.length > 0);
  return (
    <Card title="历史上这些时候">
      <p className="mb-3 text-[12px] leading-relaxed text-ink-3">
        每次进入这个区间算一段（离上一次超过 {d.rules.episodeGapDays} 天算新的一段）。“同期”是这一段开始前后各 2 年里每天买入的平均结果，大约等于那几年一直定投；倍数按这一段里每天买入的几何平均。段数太少，所以结论都只写“样本不足”和各段方向是否一致。
      </p>
      <div className="space-y-5">
        {list.map((e) => (
          <div key={e.zone.key}>
            <h3 className="text-[14px] font-semibold">
              {e.zone.name}
              <span className="ml-2 text-[12px] font-normal text-ink-3">
                {e.zone.low ? "低位" : "高位"} · {e.rows.length} 段，共 {e.totalDays} 天 · {e.from} 起可算
              </span>
            </h3>
            <div className="mt-1">
              <Fold key={mode} defaultOpen={mode === "pro"} label={["看每一段", "收起每一段"]} summary={<Summary e={e} />}>
                <Table e={e} />
              </Fold>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
        价格是 Coin Metrics 的 UTC 日线收盘。“最深再跌”看进入后 2 年内的最低收盘；“回到进入价”从这一段开始那天算起。绿色表示这一段好于同期，红色表示不如同期。
      </p>
    </Card>
  );
}
