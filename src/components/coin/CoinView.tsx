"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Analysis, LightSummary } from "@/lib/analysis";
import { COINS, getCoin } from "@/lib/symbols";
import { BEGINNER_TIMEFRAMES, TF_HORIZON, TF_LABEL, TIMEFRAMES, type Timeframe } from "@/lib/types";
import { ago, fmtPct, fmtPrice, signColor } from "./format";
import { Overview } from "./Overview";
import { TdTab } from "./TdTab";
import { IndicatorsTab } from "./IndicatorsTab";
import { LevelsTab } from "./LevelsTab";
import { TrendTab } from "./TrendTab";
import { FibTab } from "./FibTab";
import { ChanTab } from "./ChanTab";
import { ReplayContext, type ReplayState } from "./replay";
import { ReplayBar } from "./ReplayBar";

const TABS = [
  { id: "overview", label: "总览", hint: "一句话结论" },
  { id: "td", label: "TD 序列", hint: "涨跌是否累了" },
  { id: "indicators", label: "指标共振", hint: "多指标投票" },
  { id: "levels", label: "支撑阻力", hint: "关键价位" },
  { id: "trend", label: "趋势强度", hint: "方向和力度" },
  { id: "fib", label: "斐波那契", hint: "回调到哪了" },
  { id: "chan", label: "缠论", hint: "笔与中枢" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const SOURCE_NOTE: Record<string, string> = {
  "binance-futures": "Binance 永续合约（USDT 本位）公开行情",
  "okx-swap": "OKX 永续合约公开行情（Binance 暂时无法访问，已切换）",
  "binance-spot": "Binance 现货公开行情（合约行情暂时无法访问，已切换；现货价与合约价略有差别）",
  local: "本地存储（交易所暂时无法访问）",
};

export type Mode = "beginner" | "pro";

/** Props every module tab receives. */
export interface TabProps {
  a: Analysis;
  mtf: LightSummary[] | null;
  mode: Mode;
  onTf: (t: Timeframe) => void;
}

export function CoinView({ coinId, initialTf, initialTab, initialAsOf = null }: { coinId: string; initialTf: Timeframe; initialTab: string; initialAsOf?: number | null }) {
  const coin = getCoin(coinId)!;
  const [tf, setTf] = useState<Timeframe>(initialTf);
  const [tab, setTab] = useState<TabId>(TABS.some((t) => t.id === initialTab) ? (initialTab as TabId) : "overview");
  const [mode, setMode] = useState<Mode>("beginner");
  const [data, setData] = useState<Analysis | null>(null);
  const [mtf, setMtf] = useState<LightSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // time machine: the bar the page is rewound to (null = live)
  const [asOf, setAsOf] = useState<number | null>(initialAsOf);
  const [picking, setPicking] = useState(false);
  const live = useRef<Analysis | null>(null);

  useEffect(() => {
    try {
      const m = localStorage.getItem("sl-mode");
      if (m === "pro" || m === "beginner") setMode(m);
      // a 5-minute link only makes sense in pro mode
      if (initialTf === "5m") setMode("pro");
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const [a, m] = await Promise.all([
          fetch(`/api/analysis?coin=${coinId}&tf=${tf}${asOf ? `&asOf=${asOf}` : ""}`).then((r) => r.json()),
          asOf ? Promise.resolve(null) : fetch(`/api/mtf?coin=${coinId}${mode === "pro" ? "&pro=1" : ""}`).then((r) => r.json()),
        ]);
        if (a.error) throw new Error(a.error);
        setData(a);
        if (!asOf) live.current = a;
        if (Array.isArray(m)) setMtf(m);
        setError(null);
      } catch (e) {
        setError((e as Error).message || "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [coinId, tf, mode, asOf],
  );

  useEffect(() => {
    load();
    if (asOf) return; // a replay never changes; no need to poll
    const id = setInterval(() => load(true), 60_000);
    return () => clearInterval(id);
  }, [load, asOf]);

  // replay points belong to one timeframe's bars
  const changeTf = useCallback((t: Timeframe) => {
    setAsOf(null);
    setPicking(false);
    setTf(t);
  }, []);

  const changeMode = (m: Mode) => {
    setMode(m);
    if (m === "beginner" && tf === "5m") changeTf("15m");
    try {
      localStorage.setItem("sl-mode", m);
    } catch {}
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tf", tf);
    url.searchParams.set("tab", tab);
    if (asOf) url.searchParams.set("asOf", String(asOf));
    else url.searchParams.delete("asOf");
    window.history.replaceState(null, "", url);
  }, [tf, tab, asOf]);

  const fresh = data && data.coin === coinId && data.tf === tf && (asOf ? data.replay?.asOf === asOf : !data.replay);

  const replay = useMemo<ReplayState>(
    () => ({
      picking,
      pick: (t: number) => {
        setPicking(false);
        setAsOf(t);
      },
      asOf: fresh ? (data?.replay?.asOf ?? null) : null,
      future: fresh ? (data?.replay?.future ?? null) : null,
    }),
    [picking, fresh, data],
  );

  return (
    <div className="space-y-4">
      {/* coin chips */}
      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex gap-2 pb-1">
          {COINS.map((c) => (
            <Link key={c.id} href={`/coin/${c.id}?tf=${tf}&tab=${tab}`} className="chip whitespace-nowrap" data-active={c.id === coinId}>
              {c.id}
            </Link>
          ))}
        </div>
      </div>

      {/* header */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-2xl font-semibold">{coin.id}</h1>
            <span className="text-ink-2">{coin.name}</span>
            <span className="text-xs text-ink-3">/ USDT</span>
          </div>
          <p className="mt-0.5 text-xs text-ink-3">{coin.intro}</p>
        </div>
        {data && (
          <div className="num">
            <div className="text-2xl font-semibold">{fmtPrice(data.price)}</div>
            <div className="text-xs" style={{ color: signColor(data.change24h) }}>
              {data.change24h >= 0 ? "↑" : "↓"} 24 小时 {fmtPct(data.change24h)}
            </div>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1 rounded-full border border-line p-1 text-sm">
          {(["beginner", "pro"] as Mode[]).map((m) => (
            <button key={m} onClick={() => changeMode(m)} className={`rounded-full px-3 py-1 ${mode === m ? "bg-ink text-bg" : "text-ink-2"}`}>
              {m === "beginner" ? "新手模式" : "专业模式"}
            </button>
          ))}
        </div>
      </div>

      {/* timeframe */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-3">看多久的行情：</span>
        {(mode === "pro" ? TIMEFRAMES : BEGINNER_TIMEFRAMES).map((t) => (
          <button key={t} onClick={() => changeTf(t)} className="chip" data-active={t === tf} title={TF_HORIZON[t]}>
            {TF_LABEL[t]}
            {mode === "beginner" && <span className="ml-1 hidden text-[11px] opacity-70 md:inline">· {TF_HORIZON[t].replace(/（.*）/, "")}</span>}
          </button>
        ))}
      </div>

      <ReplayBar
        tf={tf}
        asOf={asOf}
        picking={picking}
        data={fresh ? data : null}
        live={live.current}
        error={asOf ? error : null}
        onPicking={setPicking}
        onAsOf={(t) => {
          setPicking(false);
          setAsOf(t);
        }}
      />

      {/* tabs */}
      <div className="-mx-4 overflow-x-auto border-b border-line px-4">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative whitespace-nowrap px-3 pb-2.5 pt-1 text-sm ${tab === t.id ? "font-semibold text-ink" : "text-ink-2 hover:text-ink"}`}
            >
              {t.label}
              {mode === "beginner" && <span className="ml-1 text-[11px] font-normal text-ink-3">{t.hint}</span>}
              {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-accent" />}
            </button>
          ))}
        </div>
      </div>

      {error && !fresh && (
        <div className="card p-6 text-center text-sm text-ink-2">
          {error}
          <button onClick={() => load()} className="ml-3 rounded-lg border border-line px-3 py-1 text-ink">重试</button>
        </div>
      )}
      {!fresh && !error && <Skeleton />}
      {fresh && (
        <ReplayContext.Provider value={replay}>
        <div className={loading ? "opacity-60 transition" : "transition"}>
          {tab === "overview" && <Overview a={data} mtf={mtf} mode={mode} onTf={changeTf} onTab={(t) => setTab(t as TabId)} />}
          {tab === "td" && <TdTab a={data} mtf={mtf} mode={mode} onTf={changeTf} />}
          {tab === "indicators" && <IndicatorsTab a={data} mtf={mtf} mode={mode} onTf={changeTf} />}
          {tab === "levels" && <LevelsTab a={data} mtf={mtf} mode={mode} onTf={changeTf} />}
          {tab === "trend" && <TrendTab a={data} mtf={mtf} mode={mode} onTf={changeTf} />}
          {tab === "fib" && <FibTab a={data} mtf={mtf} mode={mode} onTf={changeTf} />}
          {tab === "chan" && <ChanTab a={data} mtf={mtf} mode={mode} onTf={changeTf} />}
          <p className="mt-4 text-right text-[11px] text-ink-3">
            数据来源 {SOURCE_NOTE[data.source] ?? SOURCE_NOTE.local} · 更新于 {ago(data.updatedAt)}
            {!asOf && " · 每分钟自动刷新"}
            {data.source !== "binance-spot" && (
              <>
                <br />
                价格为永续合约最新成交价；交易所的止损可能按标记价触发，剧烈行情中两者会有差距。
              </>
            )}
          </p>
        </div>
        </ReplayContext.Provider>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="card h-[480px] animate-pulse" />
      <div className="space-y-4">
        <div className="card h-56 animate-pulse" />
        <div className="card h-56 animate-pulse" />
      </div>
    </div>
  );
}
