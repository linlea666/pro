"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ExtremeRow, MovesView as View, Period, WindowNow } from "@/lib/moves";
import { HOLD_DAYS, MOVE_FACTS, type Freq, type LevSide, type MoveBand } from "@/lib/ta/moves";
import { track } from "../track";

type Mode = "beginner" | "pro";
const REFRESH_MS = 30_000;
const COINS = ["BTC", "ETH"];
const WIN_NAME: Record<WindowNow["key"], string> = { "1h": "1 小时", "4h": "4 小时", "24h": "24 小时", "7d": "7 天" };
const PERIOD_NAME: Record<Period, string> = { all: "全部历史", year: "最近 1 年", d90: "最近 90 天" };
const BAND_CLASS: Record<MoveBand, string> = {
  平常: "bg-panel-2 text-ink-3",
  偏大: "bg-panel-2 text-ink-2",
  大: "bg-warn-soft text-ink",
  很大: "bg-warn-soft text-ink font-medium",
  极端: "bg-ink text-bg font-medium",
};

const day = (t: number | null | undefined) => (t == null ? "—" : new Date(t * 1000).toISOString().slice(0, 10));
const signed = (x: number | null | undefined, d = 2) => (x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}%`);
const tone = (x: number | null | undefined) => (x == null || x === 0 ? "" : x < 0 ? "text-down" : "text-up");
const price = (x: number | null) => (x == null ? "—" : x >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2));

/** "约每 5 天一次", from seconds per occurrence. */
function every(sec: number | null | undefined): string {
  if (sec == null) return "没出现过";
  const h = sec / 3600;
  if (h < 1.5) return "约每小时一次";
  if (h < 36) return `约每 ${Math.round(h)} 小时一次`;
  const d = h / 24;
  if (d < 1.5) return "约每天一次";
  if (d < 60) return `约每 ${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)} 天一次`;
  if (d < 365) return `约每 ${Math.round(d / 30)} 个月一次`;
  return `约每 ${Math.round((d / 365) * 10) / 10} 年一次`;
}

function Band({ b }: { b: MoveBand | null }) {
  if (!b) return null;
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${BAND_CLASS[b]}`}>{b}</span>;
}

function Card({ title, extra, children }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card min-w-0 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {extra && <div className="ml-auto text-[12px] text-ink-3">{extra}</div>}
      </div>
      {children}
    </section>
  );
}

function Toggle<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-line p-1 text-sm">
      {options.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} className={`rounded-full px-3 py-1 ${value === k ? "bg-ink text-bg" : "text-ink-2"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** The 涨跌统计 page: how big today's move is for BTC / ETH, against each coin's own history. */
export function MovesView() {
  const [d, setD] = useState<{ coins: View[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("beginner");
  const [coin, setCoin] = useState("BTC");

  useEffect(() => {
    try {
      const m = localStorage.getItem("sl-mode");
      if (m === "pro" || m === "beginner") setMode(m);
      const q = new URLSearchParams(location.search).get("coin")?.toUpperCase();
      const c = q && COINS.includes(q) ? q : localStorage.getItem("sl-moves-coin");
      if (c && COINS.includes(c)) setCoin(c);
    } catch {}
    track("view_moves", "moves");
    let alive = true;
    const get = () =>
      fetch("/api/moves")
        .then(async (r) => {
          const b = await r.json().catch(() => null);
          if (!r.ok || !b || b.error) throw new Error(b?.error || "涨跌统计暂时无法加载，请稍后再试");
          return b as { coins: View[] };
        })
        .then((b) => {
          if (!alive) return;
          setD(b);
          setError(null);
        })
        .catch((e) => alive && setError((e as Error).message || "加载失败"));
    get();
    const id = setInterval(() => document.visibilityState === "visible" && get(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const save = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };
  const v = d?.coins.find((c) => c.coin === coin) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">涨跌统计：现在这一波算大还是小</h1>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
            拿现在的涨跌和这个币自己的历史比：排第几、多常见、极端时有多大。只描述波动，不预测方向。
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Toggle
            value={coin}
            options={COINS.map((c) => [c, c] as [string, string])}
            onChange={(c) => {
              setCoin(c);
              save("sl-moves-coin", c);
            }}
          />
          <Toggle
            value={mode}
            options={[
              ["beginner", "新手模式"],
              ["pro", "专业模式"],
            ]}
            onChange={(m) => {
              setMode(m);
              save("sl-mode", m);
            }}
          />
        </div>
      </div>

      {error && !d && <div className="card p-6 text-center text-sm text-ink-2">{error}</div>}
      {!d && !error && <div className="card h-64 animate-pulse" />}

      {v && (
        <>
          {error && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12px] text-ink">刷新失败（{error}），下面是上一次的数据。</p>}
          <Headline v={v} />
          <NowTiles v={v} mode={mode} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Buckets v={v} mode={mode} />
            <Typicals v={v} mode={mode} />
          </div>
          <Leverage v={v} mode={mode} />
          <Extremes v={v} mode={mode} />
          {d && <Compare coins={d.coins} />}
          <footer className="space-y-1 text-[11px] leading-relaxed text-ink-3">
            <p>
              数据：交易所 USDT 永续合约 K 线（{v.source}），日线按 UTC 0 点（北京时间 8 点）收盘；“现在”的涨跌用最新成交价和 1 / 4 / 24 小时、7 天前的价格比，和交易所 App 的 24 小时涨跌是同一种算法。
              {!v.live && " 实时行情暂时取不到，现在用的是最后一根保存的 1 小时收盘。"}
            </p>
            <p>分位 = 历史上比现在小的那部分占多少，按大小算、不分涨跌；“多久一次”= 同一方向、至少这么大的次数摊到整段历史上。{MOVE_FACTS.notSignal}</p>
          </footer>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- ① now

function Headline({ v }: { v: View }) {
  const w = v.windows.find((x) => x.key === "24h")!;
  const big = v.windows.filter((x) => x.key !== "24h" && x.rankAll != null && x.rankAll >= 95);
  return (
    <section className="card space-y-1.5 p-4">
      <p className="text-[17px] font-semibold leading-snug sm:text-lg">
        {v.coin} 现价 <span className="num">{price(v.price)}</span>
        {w.pct == null ? (
          "，24 小时涨跌暂时算不出来。"
        ) : (
          <>
            ，24 小时{w.pct < 0 ? "跌" : "涨"} <span className={`num ${tone(w.pct)}`}>{Math.abs(w.pct).toFixed(2)}%</span>
            {w.rankAll != null && (
              <>
                ：比历史上 <span className="num">{Math.round(w.rankAll)}%</span> 的日子都大，算「{w.band}」
              </>
            )}
            {w.freq?.everySec != null && `，同方向这么大的${w.pct < 0 ? "跌" : "涨"}幅${every(w.freq.everySec)}`}。
          </>
        )}
      </p>
      {big.length > 0 && (
        <p className="text-[13px] leading-relaxed text-ink-2">
          {big.map((x) => `${WIN_NAME[x.key]}${x.pct! < 0 ? "跌" : "涨"} ${Math.abs(x.pct!).toFixed(2)}%（排在历史前 ${Math.max(0.1, Math.round((100 - x.rankAll!) * 10) / 10)}%）`).join("、")}，短时间里动得很快，止损和杠杆要按现在的波动来定。
        </p>
      )}
      <p className="text-[12px] leading-relaxed text-ink-3">{MOVE_FACTS.notSignal}</p>
    </section>
  );
}

function Tile({ label, value, valueClass = "", chip, children }: { label: string; value: string; valueClass?: string; chip?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-start gap-1.5">
        <span className="text-[12px] text-ink-3">{label}</span>
        {chip && <span className="ml-auto shrink-0">{chip}</span>}
      </div>
      <div className={`num mt-1 text-[20px] font-semibold leading-tight ${valueClass}`}>{value}</div>
      {children && <div className="mt-1 space-y-0.5 text-[11px] leading-relaxed text-ink-3">{children}</div>}
    </div>
  );
}

function NowTiles({ v, mode }: { v: View; mode: Mode }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {v.windows.map((w) => (
        <Tile key={w.key} label={WIN_NAME[w.key]} value={signed(w.pct)} valueClass={tone(w.pct)} chip={<Band b={w.band} />}>
          {w.rankAll != null && (
            <p>
              比 <b className="num text-ink-2">{w.rankAll}%</b> 的历史大{mode === "pro" && w.rankYear != null && <>（最近 1 年 {w.rankYear}%）</>}
            </p>
          )}
          {w.freq && w.pct != null && <p>{every(w.freq.everySec)}</p>}
        </Tile>
      ))}
      <Tile label="24 小时振幅" value={v.range24 ? `${v.range24.pct.toFixed(2)}%` : "—"} chip={<Band b={v.range24?.band ?? null} />}>
        {v.range24 && (
          <>
            <p>最高到最低差多少；爆仓看的是影线</p>
            <p>
              比 <b className="num text-ink-2">{v.range24.rank}%</b> 的日子大 · 中位 {v.range24.p50?.toFixed(1)}%
            </p>
          </>
        )}
      </Tile>
      <Tile label="离 30 天最高价" value={v.fromHigh30 ? signed(v.fromHigh30.pct) : "—"} valueClass={tone(v.fromHigh30?.pct)}>
        {v.fromHigh30 && (
          <p>
            最高 <span className="num">{price(v.fromHigh30.high)}</span>（{day(v.fromHigh30.t)}）
          </p>
        )}
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------- ② buckets

function freqCell(f: Freq, mode: Mode, side: "down" | "up") {
  return (
    <>
      <span className={`num ${side === "down" ? "text-down" : "text-up"}`}>{f.share.toFixed(1)}%</span>
      <span className="ml-1.5 text-[11px] text-ink-3">{f.n ? every(f.everySec).replace("一次", "") : "—"}</span>
      {mode === "pro" && f.last != null && <div className="text-[10px] text-ink-3">最近 {day(f.last)}</div>}
    </>
  );
}

function Buckets({ v, mode }: { v: View; mode: Mode }) {
  const [p, setP] = useState<Period>("all");
  const b = v.buckets[p];
  const max = Math.max(1, ...b.rows.flatMap((r) => [r.down.share, r.up.share]));
  const label = (lo: number, hi: number | null) => (hi == null ? `${lo}% 以上` : `${lo}–${hi}%`);
  return (
    <Card
      title="单日涨跌幅分档：历史上各占多少天"
      extra={
        <select value={p} onChange={(e) => setP(e.target.value as Period)} className="rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink-2">
          {(Object.keys(PERIOD_NAME) as Period[]).map((k) => (
            <option key={k} value={k}>
              {PERIOD_NAME[k]}
            </option>
          ))}
        </select>
      }
    >
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] text-ink-3">
            <th className="pb-1.5 font-normal">幅度</th>
            <th className="pb-1.5 font-normal">跌的天数占比 · 多久一次</th>
            <th className="pb-1.5 font-normal">涨的天数占比 · 多久一次</th>
          </tr>
        </thead>
        <tbody>
          {b.rows.map((r, i) => {
            const now = v.bucketNow?.index === i ? v.bucketNow.side : null;
            return (
              <tr key={r.lo} className="border-t border-line align-top">
                <td className="num whitespace-nowrap py-1.5 pr-2 text-ink-2">{label(r.lo, r.hi)}</td>
                <td className={`py-1.5 pr-2 ${now === "down" ? "rounded bg-down-soft" : ""}`}>
                  <div className="mb-0.5 h-1.5 rounded-full bg-down/70" style={{ width: `${(r.down.share / max) * 100}%` }} />
                  {freqCell(r.down, mode, "down")}
                  {now === "down" && <span className="ml-1.5 text-[11px] font-medium text-ink">← 现在</span>}
                </td>
                <td className={`py-1.5 ${now === "up" ? "rounded bg-up-soft" : ""}`}>
                  <div className="mb-0.5 h-1.5 rounded-full bg-up/70" style={{ width: `${(r.up.share / max) * 100}%` }} />
                  {freqCell(r.up, mode, "up")}
                  {now === "up" && <span className="ml-1.5 text-[11px] font-medium text-ink">← 现在</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        按日线收盘到收盘算，共 {b.days.toLocaleString("en-US")} 天（{day(b.from)} 起）。“现在”按 24 小时涨跌标在全部历史的那一档。
        {p !== "all" && " 行情冷热不同，最近一段和全部历史可能差很多，两个都看。"}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- ③ typical and extremes

function Typicals({ v, mode }: { v: View; mode: Mode }) {
  return (
    <Card title="一般动多少，极端动多少">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-ink-3">
              <th className="pb-1.5 font-normal">时间段</th>
              <th className="pb-1.5 font-normal">一半时候不超过</th>
              {mode === "pro" && <th className="pb-1.5 font-normal">90%</th>}
              <th className="pb-1.5 font-normal">95%</th>
              {mode === "pro" && <th className="pb-1.5 font-normal">99%</th>}
              <th className="pb-1.5 font-normal">最大跌</th>
              <th className="pb-1.5 font-normal">最大涨</th>
            </tr>
          </thead>
          <tbody className="num">
            {v.windows.map((w) => {
              const t = w.typical;
              const q = (x: number | null) => (x == null ? "—" : `${x.toFixed(x < 1 ? 2 : 1)}%`);
              return (
                <tr key={w.key} className="border-t border-line align-top">
                  <td className="py-1.5 pr-2 text-ink-2">{WIN_NAME[w.key]}</td>
                  <td className="py-1.5 pr-2">{q(t.p50)}</td>
                  {mode === "pro" && <td className="py-1.5 pr-2">{q(t.p90)}</td>}
                  <td className="py-1.5 pr-2">{q(t.p95)}</td>
                  {mode === "pro" && <td className="py-1.5 pr-2">{q(t.p99)}</td>}
                  <td className="py-1.5 pr-2">
                    <span className="text-down">{signed(t.maxDown?.pct, 1)}</span>
                    <div className="text-[10px] text-ink-3">{day(t.maxDown?.t)}</div>
                  </td>
                  <td className="py-1.5">
                    <span className="text-up">{signed(t.maxUp?.pct, 1)}</span>
                    <div className="text-[10px] text-ink-3">{day(t.maxUp?.t)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-ink-3">
        <p>“一半时候不超过”是中位数，“95%”是 100 次里有 95 次不超过这个幅度（不分涨跌）。</p>
        {v.worst7 && v.worst30 && (
          <p>
            连续下跌最狠的一段：7 天 <span className="num text-down">{signed(v.worst7.pct, 1)}</span>（{day(v.worst7.from)} 起），30 天{" "}
            <span className="num text-down">{signed(v.worst30.pct, 1)}</span>（{day(v.worst30.from)} 起）。
          </p>
        )}
        {mode === "pro" &&
          v.windows.map((w) => (
            <p key={w.key}>
              {WIN_NAME[w.key]}：{w.basis}，{w.typical.n.toLocaleString("en-US")} 个样本，{day(w.typical.from)} 起。
            </p>
          ))}
      </div>
    </Card>
  );
}

function ExtremeList({ rows, dir, afterDays }: { rows: ExtremeRow[]; dir: 1 | -1; afterDays: number[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[340px] text-[13px]">
        <thead>
          <tr className="text-left text-[11px] text-ink-3">
            <th className="pb-1.5 font-normal">日期（UTC）</th>
            <th className="pb-1.5 font-normal">当天</th>
            {afterDays.map((k) => (
              <th key={k} className="pb-1.5 font-normal">
                之后 {k} 天
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((r) => (
            <tr key={r.t} className="border-t border-line">
              <td className="py-1 pr-2 text-ink-2">{day(r.t)}</td>
              <td className={`py-1 pr-2 font-medium ${dir < 0 ? "text-down" : "text-up"}`}>{signed(r.pct, 1)}</td>
              {r.after.map((a, k) => (
                <td key={k} className={`py-1 pr-2 ${tone(a)}`}>
                  {signed(a, 1)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Extremes({ v, mode }: { v: View; mode: Mode }) {
  const n = mode === "pro" ? 10 : 5;
  const s = v.swing;
  return (
    <Card title="历史上最大的单日涨跌" extra={`每次至少隔 3 天，同一轮暴跌只算一次`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-[13px] font-medium text-down">跌得最多的 {n} 天</h3>
          <ExtremeList rows={v.topDrops.slice(0, n)} dir={-1} afterDays={v.afterDays} />
        </div>
        <div>
          <h3 className="mb-1 text-[13px] font-medium text-up">涨得最多的 {n} 天</h3>
          <ExtremeList rows={v.topRises.slice(0, n)} dir={1} afterDays={v.afterDays} />
        </div>
      </div>
      <div className="mt-3 space-y-1 text-[12px] leading-relaxed text-ink-2">
        {(s.down || s.up) && (
          <p>
            单日{s.down ? `跌幅进入最大 5% 之后，接下来 3 天平均每天的涨跌幅是平时的 ${s.down.ratio.toFixed(1)} 倍` : ""}
            {s.down && s.up ? "；涨幅进入最大 5% 之后是 " : s.up ? "涨幅进入最大 5% 之后，接下来 3 天平均每天的涨跌幅是平时的 " : ""}
            {s.up ? `${s.up.ratio.toFixed(1)} 倍` : ""}。大波动后面常跟着大波动，这只说幅度。
          </p>
        )}
        <p className="text-ink-3">{MOVE_FACTS.direction}上表“之后几天”有涨有跌，只是事实记录，不要据此认为大跌之后一定反弹。</p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- ④ leverage

function levCell(s: LevSide) {
  return (
    <>
      <span className="num">{s.share < 0.1 && s.share > 0 ? "<0.1" : s.share.toFixed(1)}%</span>
      <div className="text-[10px] text-ink-3">{every(s.everySec).replace("一次", "")}</div>
    </>
  );
}

function Leverage({ v, mode }: { v: View; mode: Mode }) {
  return (
    <Card title="开几倍杠杆，历史上多常被一根影线打爆" extra="逐仓、不算手续费和资金费">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-ink-3">
              <th className="pb-1.5 font-normal">杠杆</th>
              <th className="pb-1.5 font-normal">反向走多少爆仓</th>
              <th className="pb-1.5 font-normal">当天内 · 做多</th>
              <th className="pb-1.5 font-normal">当天内 · 做空</th>
              <th className="pb-1.5 font-normal">拿 {HOLD_DAYS} 天 · 做多</th>
              <th className="pb-1.5 font-normal">拿 {HOLD_DAYS} 天 · 做空</th>
            </tr>
          </thead>
          <tbody>
            {v.leverage.map((r) => (
              <tr key={r.lev} className="border-t border-line align-top">
                <td className="num py-1.5 pr-2 font-medium">{r.lev} 倍</td>
                <td className="num py-1.5 pr-2">{r.liqPct.toFixed(1)}%</td>
                <td className="py-1.5 pr-2">{levCell(r.day.long)}</td>
                <td className="py-1.5 pr-2">{levCell(r.day.short)}</td>
                <td className="py-1.5 pr-2">{levCell(r.week.long)}</td>
                <td className="py-1.5">{levCell(r.week.short)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-ink-3">
        <p>
          算法：假设每天 UTC 0 点（北京时间 8 点）开盘时开仓，看当天（或之后 {HOLD_DAYS} 天里）的最低价 / 最高价有没有碰到爆仓价，数一数历史上有多少天会被打爆。爆仓价按维持保证金率 0.5% 估算，交易所实际档位和手续费会让爆仓更早。
        </p>
        <p className="text-ink-2">
          杠杆越高，正常的日内波动就够把仓位打掉。按风险算仓位（止损放在结构之外、每笔只亏本金的 1–2%）比靠低杠杆“扛”更重要，计划页和实时盯盘都能按止损算仓位。
        </p>
        {mode === "pro" && <p>“拿 {HOLD_DAYS} 天”是从开仓那天开盘起 {HOLD_DAYS} 根日线内的最低 / 最高价；样本互相重叠，只看比例，不做显著性检验。</p>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- ⑤ BTC vs ETH

function Compare({ coins }: { coins: View[] }) {
  if (coins.length < 2) return null;
  return (
    <Card title="BTC 和 ETH 放在一起看">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-ink-3">
              <th className="pb-1.5 font-normal">币</th>
              <th className="pb-1.5 font-normal">24 小时</th>
              <th className="pb-1.5 font-normal">在自己历史里</th>
              <th className="pb-1.5 font-normal">单日一半时候不超过</th>
              <th className="pb-1.5 font-normal">单日 95%</th>
              <th className="pb-1.5 font-normal">10 倍当天被打爆（多 / 空）</th>
            </tr>
          </thead>
          <tbody className="num">
            {coins.map((c) => {
              const w = c.windows.find((x) => x.key === "24h")!;
              const l10 = c.leverage.find((r) => r.lev === 10);
              return (
                <tr key={c.coin} className="border-t border-line">
                  <td className="py-1.5 pr-2 font-medium">{c.coin}</td>
                  <td className={`py-1.5 pr-2 ${tone(w.pct)}`}>{signed(w.pct)}</td>
                  <td className="py-1.5 pr-2">
                    {w.rankAll != null ? `${Math.round(w.rankAll)}%` : "—"} <Band b={w.band} />
                  </td>
                  <td className="py-1.5 pr-2">{w.typical.p50 == null ? "—" : `${w.typical.p50.toFixed(1)}%`}</td>
                  <td className="py-1.5 pr-2">{w.typical.p95 == null ? "—" : `${w.typical.p95.toFixed(1)}%`}</td>
                  <td className="py-1.5">{l10 ? `${l10.day.long.share.toFixed(1)}% / ${l10.day.short.share.toFixed(1)}%` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        同样涨跌 5%，在平时波动小的币上更少见，所以要看各自的分位，不要直接比百分比。想看关键位和止损，去
        <Link href="/watch" className="underline">
          实时盯盘
        </Link>
        。
      </p>
    </Card>
  );
}
