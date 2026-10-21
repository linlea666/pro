"use client";

import { useEffect, useState } from "react";
import { EVENT_NAMES, type EventName } from "@/lib/event-names";
import type { RetentionRow, WeekRow } from "@/lib/server/events";
import { Tile } from "./ui";

type Metrics = { events: number; since: number | null; dau: number; wau: number; mau: number; weeks: WeekRow[]; retention: RetentionRow[] };

const FEATURES: EventName[] = ["view_verdict", "view_plan", "view_watch", "defense_done", "open_explain", "click_ai", "use_calc", "check_position", "use_replay"];
const share = (n: number | undefined, of: number) => (of ? `${Math.round(((n ?? 0) / of) * 100)}%` : "—");
const day = (ms: number) => new Date(ms).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });

/** Anonymous usage, by the PRD's product-metric definitions (domain G). */
export function MetricsPanel() {
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    fetch("/api/admin/metrics")
      .then((r) => r.json())
      .then(setM);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">产品指标</h1>
      <p className="text-xs leading-relaxed text-ink-3">
        只记录浏览器里随机生成的匿名访客 ID、事件名、页面和时间，不记录 IP 和个人信息，数据只存在本站数据库，保留约 400 天。同一个人换浏览器或清空缓存会算成新访客。
        {m?.since && ` 数据从 ${new Date(m.since).toLocaleDateString("zh-CN")} 开始，共 ${m.events} 条事件。`}
      </p>
      {!m ? (
        <div className="h-48 animate-pulse rounded-xl bg-panel-2" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Tile label="日活（24 小时）" value={m.dau} />
            <Tile label="周活（7 天）" value={m.wau} />
            <Tile label="月活（30 天）" value={m.mau} />
          </div>

          <section className="card p-4">
            <h2 className="mb-1 text-[15px] font-semibold">留存</h2>
            <p className="mb-3 text-xs text-ink-3">首次访问后第 1 / 7 / 30 天（按 24 小时计）再次来访的比例；只统计 90 天内首次访问、并且已经过了这一天的访客。目标（假设）：第 7 天 ≥ 20%。行情大波动时留存会被推高，比较时注意当时的行情。</p>
            <div className="grid grid-cols-3 gap-3">
              {m.retention.map((r) => (
                <div key={r.day} className="rounded-lg bg-panel-2 p-3">
                  <div className="text-xs text-ink-3">第 {r.day} 天</div>
                  <div className="num text-lg font-semibold">{r.rate == null ? "—" : `${r.rate}%`}</div>
                  <div className="text-[11px] text-ink-3">{r.returned} / {r.cohort} 位访客</div>
                </div>
              ))}
            </div>
          </section>

          <section className="card overflow-x-auto p-4">
            <h2 className="mb-1 text-[15px] font-semibold">每周概况与核心功能使用率</h2>
            <p className="mb-3 text-xs text-ink-3">每 7 天一行，最新在上；功能列是“用过该功能的访客 ÷ 当周访客”。默认打开的页面天然使用率高，不要只凭使用率砍功能。</p>
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="py-1.5 pr-3 font-normal">7 天截至</th>
                  <th className="py-1.5 pr-3 font-normal">访客</th>
                  <th className="py-1.5 pr-3 font-normal">新访客</th>
                  {FEATURES.map((f) => (
                    <th key={f} className="py-1.5 pr-3 font-normal">{EVENT_NAMES[f]}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="num">
                {m.weeks.map((w) => (
                  <tr key={w.from} className="border-t border-line">
                    <td className="py-1.5 pr-3">{day(w.from + 7 * 86400000)}</td>
                    <td className="py-1.5 pr-3">{w.active}</td>
                    <td className="py-1.5 pr-3">{w.newVisitors}</td>
                    {FEATURES.map((f) => (
                      <td key={f} className="py-1.5 pr-3">{share(w.features[f], w.active)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <p className="text-xs leading-relaxed text-ink-3">
            “完成防守位任务”= 在“趋势与计划”页用计划给出的止损（远或近）、或在“实时盯盘”页用转强后的止损算了仓位，即 PRD 的“防守位页使用率”。“首次理解关键结论比例”需要首访小测，尚未实现。数据及时性、计算延迟和失败率见“运行概览”。
          </p>
        </>
      )}
    </div>
  );
}
