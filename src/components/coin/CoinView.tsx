"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Analysis, LightSummary } from "@/lib/analysis";
import type { Framework, TrendPlan } from "@/lib/trendplan";
import type { WatchView } from "@/lib/watch";
import type { PaTf, PaView } from "@/lib/pa";
import { COINS, getCoin } from "@/lib/symbols";
import { BEGINNER_TIMEFRAMES, TF_HORIZON, TF_LABEL, TF_SECONDS, TIMEFRAMES, type Timeframe } from "@/lib/types";
import { ago, fmtBjTime, fmtPct, fmtPrice, signColor } from "./format";
import { Overview } from "./Overview";
import { TdTab } from "./TdTab";
import { IndicatorsTab } from "./IndicatorsTab";
import { LevelsTab } from "./LevelsTab";
import { TrendTab } from "./TrendTab";
import { FibTab } from "./FibTab";
import { ChanTab } from "./ChanTab";
import { TrendPlanTab } from "./TrendPlanTab";
import { LessonsTab } from "./LessonsTab";
import { WatchTab } from "./WatchTab";
import { PriceActionTab } from "./PriceActionTab";
import { ReplayContext, type ReplayState } from "./replay";
import { ReplayBar } from "./ReplayBar";
import { track } from "../track";

const TABS = [
  { id: "overview", label: "总览", hint: "趋势地图" },
  { id: "plan", label: "趋势与计划", hint: "在哪认错、怎么拿住" },
  { id: "watch", label: "实时盯盘", hint: "关键位上别接飞刀" },
  { id: "learn", label: "新手学堂", hint: "用真实数字讲" },
  { id: "td", label: "TD 序列", hint: "涨跌是否累了" },
  { id: "indicators", label: "指标共振", hint: "多指标投票" },
  { id: "levels", label: "支撑阻力", hint: "关键价位" },
  { id: "trend", label: "趋势强度", hint: "方向和力度" },
  { id: "fib", label: "斐波那契", hint: "回调到哪了" },
  { id: "chan", label: "缠论", hint: "笔与中枢" },
  { id: "pa", label: "裸 K", hint: "趋势、位置、K 线确认" },
] as const;
type TabId = (typeof TABS)[number]["id"];
/** what beginners see; the module tabs live in pro mode */
const BEGINNER_TABS: TabId[] = ["overview", "plan", "watch", "pa", "learn"];
/** tabs that load their own data rather than the chart timeframe's analysis */
const OWN_DATA: TabId[] = ["plan", "learn", "watch", "pa"];
const PA_TFS: PaTf[] = ["15m", "1h", "4h", "1d"];
const PA_PREF = "sl-pa-tf";

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
  const router = useRouter();
  // trend map and trading plans: independent of the chart's timeframe
  const [fw, setFw] = useState<Framework>("4h");
  const [plan, setPlan] = useState<TrendPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  // the key-level watch (15-minute bars), loaded only while its tab is open
  const [watch, setWatch] = useState<{ key: string; v: WatchView } | null>(null);
  const [watchError, setWatchError] = useState<{ key: string; msg: string } | null>(null);
  // the naked-K page: its own timeframe (remembered in this browser), loaded only while its tab is open
  const [pf, setPfState] = useState<PaTf>("4h");
  const [pa, setPa] = useState<{ key: string; v: PaView } | null>(null);
  const [paError, setPaError] = useState<{ key: string; msg: string } | null>(null);

  useEffect(() => {
    try {
      const p = localStorage.getItem(PA_PREF) as PaTf | null;
      if (p && PA_TFS.includes(p)) setPfState(p);
    } catch {}
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
        else track("use_replay", `replay:${coinId}:${tf}:${asOf}`);
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

  useEffect(() => {
    if (data && !data.replay && tab === "overview") track("view_verdict", `verdict:${data.coin}:${data.tf}`);
  }, [data, tab]);

  // a replay rewinds the plan to the end of the bar picked on whichever chart
  const planEnd = asOf ? asOf + TF_SECONDS[tf] : null;
  useEffect(() => {
    let alive = true;
    const get = () =>
      fetch(`/api/plan?coin=${coinId}&fw=${fw}${asOf ? `&asOf=${asOf}&tf=${tf}` : ""}`)
        .then((r) => r.json())
        .then((b) => {
          if (!alive) return;
          if (b.error) throw new Error(b.error);
          setPlan(b);
          setPlanError(null);
        })
        .catch((e) => alive && setPlanError((e as Error).message || "加载失败"));
    get();
    if (asOf)
      return () => {
        alive = false;
      };
    const id = setInterval(get, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [coinId, fw, asOf, tf]);
  const planFresh = plan && plan.coin === coinId && plan.framework === fw && (planEnd ? plan.replay?.end === planEnd : !plan.replay) ? plan : null;

  useEffect(() => {
    if (planFresh && !planFresh.replay && tab === "plan") track("view_plan", `plan:${planFresh.coin}:${planFresh.framework}`);
  }, [planFresh, tab]);

  // the watch: polled every 15 seconds while its tab is open and the page is in front; a replay never changes
  const watchTf = asOf ? tf : null;
  const watchKey = `${coinId}:${asOf ? `${asOf}:${tf}` : "live"}`;
  const watchOpen = tab === "watch";
  useEffect(() => {
    if (!watchOpen) return;
    let alive = true;
    const key = `${coinId}:${asOf ? `${asOf}:${watchTf}` : "live"}`;
    const get = () =>
      fetch(`/api/watch?coin=${coinId}${asOf ? `&asOf=${asOf}&tf=${watchTf}` : ""}`)
        .then((r) => r.json())
        .then((b) => {
          if (!alive) return;
          if (b.error) throw new Error(b.error);
          setWatch({ key, v: b });
          setWatchError(null);
        })
        .catch((e) => alive && setWatchError({ key, msg: (e as Error).message || "加载失败" }));
    get();
    if (asOf)
      return () => {
        alive = false;
      };
    const visible = () => document.visibilityState === "visible";
    const id = setInterval(() => visible() && get(), 15_000);
    const onVis = () => visible() && get();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [watchOpen, coinId, asOf, watchTf]);
  const watchFresh = watch?.key === watchKey ? watch.v : null;
  const watchErr = watchError?.key === watchKey ? watchError.msg : null;

  useEffect(() => {
    if (watchFresh && !watchFresh.replay && tab === "watch") track("view_watch", `watch:${watchFresh.coin}`);
  }, [watchFresh, tab]);

  // the naked-K page: refreshed every minute while its tab is open and the page is in front; a replay never changes
  const paKey = `${coinId}:${pf}:${asOf ? `${asOf}:${tf}` : "live"}`;
  const paOpen = tab === "pa";
  const paTf = asOf ? tf : null;
  useEffect(() => {
    if (!paOpen) return;
    let alive = true;
    const key = `${coinId}:${pf}:${asOf ? `${asOf}:${paTf}` : "live"}`;
    const get = () =>
      fetch(`/api/pa?coin=${coinId}&pf=${pf}${asOf ? `&asOf=${asOf}&tf=${paTf}` : ""}`)
        .then((r) => r.json())
        .then((b) => {
          if (!alive) return;
          if (b.error) throw new Error(b.error);
          setPa({ key, v: b });
          setPaError(null);
        })
        .catch((e) => alive && setPaError({ key, msg: (e as Error).message || "加载失败" }));
    get();
    if (asOf)
      return () => {
        alive = false;
      };
    const visible = () => document.visibilityState === "visible";
    const id = setInterval(() => visible() && get(), 60_000);
    const onVis = () => visible() && get();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [paOpen, coinId, pf, asOf, paTf]);
  const paFresh = pa?.key === paKey ? pa.v : null;
  const paErr = paError?.key === paKey ? paError.msg : null;
  const changePf = useCallback((p: PaTf) => {
    setPfState(p);
    try {
      localStorage.setItem(PA_PREF, p);
    } catch {}
  }, []);

  useEffect(() => {
    if (paFresh && !paFresh.replay && tab === "pa") track("view_pa", `pa:${paFresh.coin}`);
  }, [paFresh, tab]);

  /** Rewind to the close of bar `at` of timeframe `t` and show it on tab `to` (on another coin's page if needed). */
  const replayAt = useCallback(
    (t: Timeframe, at: number, coin = coinId, to: TabId = "plan") => {
      if (coin !== coinId) return router.push(`/coin/${coin}?tf=${t}&tab=${to}&asOf=${at}`);
      setPicking(false);
      setTf(t);
      setAsOf(at);
      setTab(to);
    },
    [coinId, router],
  );
  const watchPick = useCallback((t: Timeframe, at: number) => replayAt(t, at, coinId, "watch"), [replayAt, coinId]);
  const paPick = useCallback((t: Timeframe, at: number) => replayAt(t, at, coinId, "pa"), [replayAt, coinId]);

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

  // the timeframe the open tab analyses, for the "latest close" line under the price
  const closeTf: Timeframe = tab === "plan" ? fw : tab === "watch" ? "15m" : tab === "pa" ? pf : tf;
  const closes = useMemo(() => {
    if (asOf) {
      // a replay: the close of the picked bar on the chart's timeframe
      if (!fresh || !data) return null;
      const last = data.candles[data.candles.length - 1];
      return { main: { tf: data.tf, close: last.c, closeAt: last.t + TF_SECONDS[data.tf] }, all: [] };
    }
    const all = (mtf ?? []).map((m) => ({ tf: m.tf, close: m.close, closeAt: m.closeAt }));
    return { main: all.find((m) => m.tf === closeTf) ?? null, all };
  }, [asOf, fresh, data, mtf, closeTf]);

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
        {closes?.main && <CloseLine c={closes.main} replay={!!asOf} />}
        <div className="ml-auto flex items-center gap-1 rounded-full border border-line p-1 text-sm">
          {(["beginner", "pro"] as Mode[]).map((m) => (
            <button key={m} onClick={() => changeMode(m)} className={`rounded-full px-3 py-1 ${mode === m ? "bg-ink text-bg" : "text-ink-2"}`}>
              {m === "beginner" ? "新手模式" : "专业模式"}
            </button>
          ))}
        </div>
      </div>

      {mode === "pro" && closes && closes.all.length > 0 && (
        <div className="num -mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
          <span>各周期最新收盘（北京时间）：</span>
          {closes.all.map((m) => (
            <span key={m.tf} className={m.tf === closeTf ? "text-ink" : undefined}>
              {TF_LABEL[m.tf]} {fmtPrice(m.close)} · {fmtBjTime(m.closeAt)}
            </span>
          ))}
        </div>
      )}

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
          {(mode === "pro" ? [...TABS] : [...BEGINNER_TABS.map((id) => TABS.find((t) => t.id === id)!), ...TABS.filter((t) => t.id === tab && !BEGINNER_TABS.includes(t.id))]).map((t) => (
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

      {OWN_DATA.includes(tab) && (
        <ReplayContext.Provider value={replay}>
          {tab === "plan" &&
            (planFresh ? (
              <TrendPlanTab p={planFresh} mode={mode} fw={fw} onFw={setFw} onPick={replayAt} />
            ) : planError ? (
              <div className="card p-6 text-center text-sm text-ink-2">{planError}</div>
            ) : (
              <Skeleton />
            ))}
          {tab === "learn" && (
            <LessonsTab
              p={planFresh}
              coin={coinId}
              onReplay={(t, at, c, to) => {
                // the cases were written for the 4-hour rhythm: replay them in it
                setFw("4h");
                replayAt(t, at, c, to);
              }}
            />
          )}
          {tab === "watch" &&
            (watchFresh ? (
              <WatchTab v={watchFresh} mode={mode} onPick={watchPick} />
            ) : watchErr ? (
              <div className="card p-6 text-center text-sm text-ink-2">{watchErr}</div>
            ) : (
              <Skeleton />
            ))}
          {tab === "pa" &&
            (paFresh ? (
              <PriceActionTab v={paFresh} mode={mode} pf={pf} onPf={changePf} onPick={paPick} />
            ) : paErr ? (
              <div className="card p-6 text-center text-sm text-ink-2">{paErr}</div>
            ) : (
              <Skeleton />
            ))}
          {tab === "pa" && paFresh && (
            <p className="mt-4 text-right text-[11px] text-ink-3">
              数据来源 {SOURCE_NOTE[paFresh.source] ?? SOURCE_NOTE.local} · 更新于 {ago(paFresh.updatedAt)}
              {!asOf && " · 页面在前台时每分钟刷新"}
            </p>
          )}
          {tab === "watch" && watchFresh && (
            <p className="mt-4 text-right text-[11px] text-ink-3">
              数据来源 {SOURCE_NOTE[watchFresh.source] ?? SOURCE_NOTE.local} · 更新于 {ago(watchFresh.updatedAt)}
              {!asOf && " · 页面在前台时每 15 秒刷新"}
            </p>
          )}
          {tab !== "watch" && tab !== "pa" && planFresh && (
            <p className="mt-4 text-right text-[11px] text-ink-3">
              数据来源 {SOURCE_NOTE[planFresh.source] ?? SOURCE_NOTE.local} · 更新于 {ago(planFresh.updatedAt)}
              {!asOf && " · 每分钟自动刷新"}
            </p>
          )}
        </ReplayContext.Provider>
      )}
      {!OWN_DATA.includes(tab) && error && !fresh && (
        <div className="card p-6 text-center text-sm text-ink-2">
          {error}
          <button onClick={() => load()} className="ml-3 rounded-lg border border-line px-3 py-1 text-ink">重试</button>
        </div>
      )}
      {!OWN_DATA.includes(tab) && !fresh && !error && <Skeleton />}
      {!OWN_DATA.includes(tab) && fresh && (
        <ReplayContext.Provider value={replay}>
        <div className={loading ? "opacity-60 transition" : "transition"}>
          {tab === "overview" && <Overview a={data} mtf={mtf} mode={mode} plan={planFresh} onTf={changeTf} onTab={(t) => setTab(t as TabId)} />}
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

/** "4 小时最新收盘 83,151.8 · 10-21 16:00 收，下一根 20:00 收": everything on the page is computed on closed bars. */
function CloseLine({ c, replay }: { c: { tf: Timeframe; close: number; closeAt: number }; replay: boolean }) {
  const next = c.closeAt + TF_SECONDS[c.tf];
  const pending = next * 1000 <= Date.now();
  return (
    <div className="num text-xs leading-relaxed text-ink-3" title="页面上的分析、计划和止损都按已收盘的 K 线计算；正在走的那根只用来画图和显示现价">
      <div>
        {replay ? "回放时刻" : TF_LABEL[c.tf]}
        {replay ? ` · ${TF_LABEL[c.tf]}收盘 ` : "最新收盘 "}
        <b className="text-ink">{fmtPrice(c.close)}</b>
      </div>
      <div>
        {fmtBjTime(c.closeAt)} 收盘
        {!replay && (pending ? " · 下一根已收盘，正在更新" : ` · 下一根 ${TF_SECONDS[c.tf] >= 86400 ? fmtBjTime(next) : fmtBjTime(next).slice(6)} 收盘`)}
      </div>
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
