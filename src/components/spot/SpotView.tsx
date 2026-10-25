"use client";

import { useEffect, useState } from "react";
import type { SpotPage } from "@/lib/spot/page";
import { track } from "../track";
import { BottomListCard } from "./BottomList";
import { Episodes } from "./Episodes";
import { PriceLadder } from "./PriceLadder";
import { fmtBj, type Mode } from "./spot-ui";
import { StackPlanner } from "./StackPlanner";
import { FngCard, Headline, NowTiles, OpinionCard, RulerBars } from "./Valuation";

const REFRESH_MS = 10 * 60_000;

/** The 现货囤币 page: long-horizon valuation of BTC spot and the accumulation planner. */
export function SpotView() {
  const [d, setD] = useState<SpotPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("beginner");

  useEffect(() => {
    try {
      const m = localStorage.getItem("sl-mode");
      if (m === "pro" || m === "beginner") setMode(m);
    } catch {}
    track("view_spot", "spot");
    let alive = true;
    const get = () =>
      fetch("/api/spot")
        .then(async (r) => {
          const b = await r.json().catch(() => null);
          if (!r.ok || !b || b.error) throw new Error(b?.error || "现货估值暂时无法加载，请稍后再试");
          return b as SpotPage;
        })
        .then((b) => {
          if (!alive) return;
          setD(b);
          setError(null);
        })
        .catch((e) => alive && setError((e as Error).message || "加载失败"));
    get();
    const visible = () => document.visibilityState === "visible";
    const id = setInterval(() => visible() && get(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const changeMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem("sl-mode", m);
    } catch {}
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">现货囤币：比特币现在贵不贵</h1>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
            {d ? (
              <>
                数据日期 {d.asOfDay}（UTC 日线，Coin Metrics）· 恐惧贪婪 alternative.me{d.fng ? `（${d.fng.day}）` : ""} · 页面更新于 {fmtBj(d.fetchedAt)}
              </>
            ) : (
              "UTC 日线，Coin Metrics · 恐惧贪婪 alternative.me"
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-full border border-line p-1 text-sm">
          {(["beginner", "pro"] as Mode[]).map((m) => (
            <button key={m} onClick={() => changeMode(m)} className={`rounded-full px-3 py-1 ${mode === m ? "bg-ink text-bg" : "text-ink-2"}`}>
              {m === "beginner" ? "新手模式" : "专业模式"}
            </button>
          ))}
        </div>
      </div>

      {error && !d && (
        <div className="card p-6 text-center text-sm leading-relaxed text-ink-2">
          <p>{error}</p>
          <p className="mt-1 text-[12px] text-ink-3">数据每天更新一次，页面在前台时每 10 分钟重新读取。</p>
        </div>
      )}
      {!d && !error && <div className="card h-64 animate-pulse" />}

      {d && (
        <>
          {error && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12px] text-ink">刷新失败（{error}），下面是 {fmtBj(d.fetchedAt)} 的数据。</p>}
          <section className="card p-4">
            <Headline d={d} mode={mode} />
          </section>
          <NowTiles d={d} mode={mode} />
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="min-w-0 space-y-4">
              <RulerBars d={d} mode={mode} />
              <OpinionCard d={d} />
              <FngCard d={d} />
            </div>
            <div className="min-w-0">
              <PriceLadder d={d} />
            </div>
          </div>
          <BottomListCard d={d} mode={mode} />
          <Episodes d={d} mode={mode} />
          <StackPlanner d={d} mode={mode} />
          <footer className="space-y-1 text-[11px] leading-relaxed text-ink-3">
            <p>数据来源：Coin Metrics 社区数据 CC BY-NC 4.0（价格、流通量、MVRV，UTC 日线）；恐惧贪婪指数 alternative.me；现价来自交易所 1 小时 K 线。</p>
            <p>页面上的研究数字来自 E23（2026-10）。这一页只描述长期估值和计划的算术，不构成投资建议。</p>
          </footer>
        </>
      )}
    </div>
  );
}
