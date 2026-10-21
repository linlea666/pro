"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { WatchSummary } from "@/lib/watch";
import { ago, fmtPrice } from "./coin/format";
import { fmtAtr, STATE_ORDER, StatePill } from "./coin/watch-ui";
import { Term } from "./Term";

/** Every coin's key-level watch in one line, the most urgent first; refreshed every 30 seconds while in front. */
export function WatchBoard() {
  const [rows, setRows] = useState<WatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const get = () =>
      fetch("/api/watch")
        .then((r) => r.json())
        .then((b) => {
          if (!alive) return;
          if (!Array.isArray(b)) throw new Error(b?.error || "加载失败");
          setRows(b);
          setError(null);
        })
        .catch((e) => alive && setError((e as Error).message || "加载失败"));
    get();
    const visible = () => document.visibilityState === "visible";
    const id = setInterval(() => visible() && get(), 30_000);
    const onVis = () => visible() && get();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const sorted = rows ? [...rows].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || Math.abs(a.distAtr ?? 99) - Math.abs(b.distAtr ?? 99)) : null;
  const dirOf = (r: WatchSummary): 1 | -1 => (r.side === "short" || (!r.side && r.distAtr != null && r.distAtr > 0) ? -1 : 1);
  const levelText = (r: WatchSummary) => (r.level ? `${r.level.name} ${fmtPrice(r.level.price)}` : "附近没有关键位");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">实时盯盘：哪些币正在关键位上</h1>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
          价格碰到前一日、上周、上月的高低点或 4 小时、日线的摆动点时，先别急着<Term k="接飞刀">接</Term>。状态只按收盘的 15 分钟 K 线判断：
        </p>
        <ul className="mt-2 grid gap-2 text-[13px] leading-relaxed sm:grid-cols-3">
          <li className="card flex items-start gap-2 p-3">
            <StatePill state="falling" />
            <span className="text-ink-2">碰到关键低点后还在创新低（关键高点反过来是“别急着空”）。</span>
          </li>
          <li className="card flex items-start gap-2 p-3">
            <StatePill state="watching" />
            <span className="text-ink-2">停下来了，暂时没有再创新低，但还没转强。</span>
          </li>
          <li className="card flex items-start gap-2 p-3">
            <StatePill state="turned" />
            <span className="text-ink-2">
              15 分钟先走出更高的低点、再收盘站上反弹高点（<Term k="转强">转强</Term>）；止损放在最新低点之外。
            </span>
          </li>
        </ul>
        <p className="mt-2 text-[12px] text-ink-3">“靠近”是离关键位不远、还没碰到；“远离”是附近没什么要盯的。转强不预测方向，只是不在下跌途中去接。</p>
      </div>

      {error && !rows && <div className="card p-6 text-center text-sm text-ink-2">{error}</div>}
      {!sorted && !error && <div className="card h-64 animate-pulse" />}
      {sorted && sorted.length === 0 && <div className="card p-6 text-center text-sm text-ink-2">暂时没有数据，稍后再看。</div>}

      {sorted && sorted.length > 0 && (
        <>
          {/* phones: one card per coin */}
          <ul className="space-y-2 md:hidden">
            {sorted.map((r) => (
              <li key={r.coin}>
                <Link href={`/coin/${r.coin}?tab=watch`} className="card block p-3 hover:border-accent">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold">{r.coin}</span>
                    <StatePill state={r.state} dir={dirOf(r)} />
                    <span className="ml-auto text-[11px] text-ink-3">{ago(r.updatedAt)}</span>
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-ink">{r.headline}</p>
                  <p className="num mt-1 text-[12px] text-ink-3">
                    {levelText(r)}
                    {r.distAtr != null && `（${fmtAtr(r.distAtr)}）`}
                  </p>
                </Link>
              </li>
            ))}
          </ul>

          {/* wider screens: a table */}
          <div className="card hidden overflow-hidden md:block">
            <div className="grid grid-cols-[4.5rem_7rem_minmax(0,1fr)_15rem_5.5rem] gap-3 border-b border-line px-4 py-2 text-xs text-ink-3">
              <span>币种</span>
              <span>状态</span>
              <span>现在</span>
              <span>最近的关键位</span>
              <span className="text-right">更新</span>
            </div>
            <ul className="divide-y divide-line">
              {sorted.map((r) => (
                <li key={r.coin}>
                  <Link href={`/coin/${r.coin}?tab=watch`} className="grid grid-cols-[4.5rem_7rem_minmax(0,1fr)_15rem_5.5rem] items-center gap-3 px-4 py-2.5 hover:bg-panel-2">
                    <span className="font-semibold">{r.coin}</span>
                    <span>
                      <StatePill state={r.state} dir={dirOf(r)} />
                    </span>
                    <span className="text-[13px] leading-relaxed text-ink-2">{r.headline}</span>
                    <span className="num text-[13px]">
                      {levelText(r)}
                      {r.distAtr != null && <span className="block text-[11px] text-ink-3">{fmtAtr(r.distAtr)}</span>}
                    </span>
                    <span className="text-right text-[11px] text-ink-3">{ago(r.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <p className="text-[11px] leading-relaxed text-ink-3">
        ATR 是 1 小时 K 线的平均波动。页面在前台时每 30 秒刷新；点一个币看它的“实时盯盘”页：关键位、走过的每个新低、转强后的止损和按风险算的仓位。
      </p>
    </div>
  );
}
