"use client";

import { useEffect, useRef, useState } from "react";
import type { FlowsPage, Radar } from "@/lib/flows/page";
import type { AfterRow, BuyState, ZBand } from "@/lib/flows/stats";
import { track } from "../track";
import { fmtBj, type Mode } from "../spot/spot-ui";

const REFRESH_MS = 60_000;

/** 5.28 亿 / −1,113 万 (USD) */
export function fmtYi(usd: number | null | undefined, sign = true): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "0";
  const s = sign ? (usd > 0 ? "+" : usd < 0 ? "−" : "") : usd < 0 ? "−" : "";
  const a = Math.abs(usd);
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(a >= 1e10 ? 0 : 2)} 亿`;
  return `${s}${Math.round(a / 1e4).toLocaleString("en-US")} 万`;
}
const pct = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}%`);
const signedPct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`);
const bp = (frac: number | null | undefined) => (frac == null ? "—" : `${frac > 0 ? "+" : frac < 0 ? "−" : ""}${Math.abs(frac * 100).toFixed(4)}%`);
const zStr = (z: number | null | undefined) => (z == null ? "—" : `${z > 0 ? "+" : z < 0 ? "−" : ""}${Math.abs(z).toFixed(2)}`);
const rankText = (p: number) => (p >= 0.5 ? `前 ${Math.max(1, Math.round((1 - p) * 100))}%` : `后 ${Math.min(50, Math.round(p * 100) + 1)}%`);

const STATE_TONE: Record<BuyState, string> = {
  强: "bg-up-soft text-up",
  偏强: "bg-up-soft text-up",
  平常: "bg-panel-2 text-ink-2",
  偏弱: "bg-down-soft text-down",
  弱: "bg-down-soft text-down",
};
const BAND_TONE = (b: ZBand | null) =>
  b == null ? "bg-panel-2 text-ink-3" : b.includes("买") ? "bg-up-soft text-up" : b.includes("卖") ? "bg-down-soft text-down" : "bg-panel-2 text-ink-2";

/** The ETF 买盘 page: US spot BTC ETF flows and the Coinbase premarket radar. */
export function FlowsView() {
  const [d, setD] = useState<FlowsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("beginner");

  useEffect(() => {
    try {
      const m = localStorage.getItem("sl-mode");
      if (m === "pro" || m === "beginner") setMode(m);
    } catch {}
    track("view_flows", "flows");
    let alive = true;
    const get = () =>
      fetch("/api/flows")
        .then(async (r) => {
          const b = await r.json().catch(() => null);
          if (!r.ok || !b || b.error) throw new Error(b?.error || "ETF 买盘暂时无法加载，请稍后再试");
          return b as FlowsPage;
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
          <h1 className="text-2xl font-semibold">ETF 买盘：美国这边在买还是在卖</h1>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
            美国现货比特币 ETF 每日净流入 · Coinbase 盘前溢价{d ? ` · 页面更新于 ${fmtBj(d.fetchedAt)}（北京时间）` : ""}
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
          <p className="mt-1 text-[12px] text-ink-3">流入数据每天更新，盘前溢价每分钟更新；页面在前台时每分钟重新读取。</p>
        </div>
      )}
      {!d && !error && <div className="card h-64 animate-pulse" />}

      {d && (
        <>
          {error && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12px] text-ink">刷新失败（{error}），下面是 {fmtBj(d.fetchedAt)} 的数据。</p>}
          <Headline d={d} mode={mode} />
          <div className="grid gap-4 lg:grid-cols-2">
            <RadarCard r={d.radar} mode={mode} facts={d.facts} />
            <Schedule />
          </div>
          <FlowChart d={d} />
          {mode === "pro" && (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Similar d={d} />
                <Follows d={d} />
              </div>
              <PremiumCard r={d.radar} />
              <ZTable r={d.radar} />
            </>
          )}
          <HowToUse d={d} mode={mode} />
          <footer className="space-y-1 text-[11px] leading-relaxed text-ink-3">
            <p>流入数据：{d.source}。盘前溢价：Coinbase BTC-USD、USDT-USD 和 Binance BTCUSDT 现货的公开行情。</p>
            <p>研究数字来自 E26 / E26b（2026-10，2024-07 起的 BTC 数据）。这一页只描述资金流和溢价，不构成投资建议。</p>
          </footer>
        </>
      )}
    </div>
  );
}

function Headline({ d, mode }: { d: FlowsPage; mode: Mode }) {
  const n = d.now;
  const revised = Math.abs(d.firstFlow - n.flow) >= 1e6;
  return (
    <section className="card space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${STATE_TONE[n.state]}`}>美国买盘 · {n.state}</span>
        <span className="text-[12px] text-ink-3">按近 7 个交易日合计，在最近 120 个交易日里排{rankText(n.p7)}</span>
      </div>
      <p className="text-xl font-semibold leading-snug sm:text-2xl">
        {n.day.slice(5).replace("-", "/")}（美东）净{n.flow >= 0 ? "流入" : "流出"} <span className={n.flow >= 0 ? "text-up" : "text-down"}>{fmtYi(Math.abs(n.flow), false)}美元</span>
      </p>
      <p className="text-[14px] leading-relaxed text-ink-2">
        在最近 120 个交易日里排{rankText(n.pct)}，已经连续 {Math.abs(n.streak)} 天{n.streak > 0 ? "流入" : "流出"}，近 7 日合计 {fmtYi(n.sum7)}美元。
        {revised && <span className="text-ink-3">（首次公布 {fmtYi(d.firstFlow)}，之后修正）</span>}
      </p>
      <p className="text-[13px] leading-relaxed text-ink-3">
        这说明美国机构最近在买还是在卖，不说明接下来会涨：{d.facts.flowNoEdge.replace("研究（E26）：", "")}
        {mode === "beginner" && " 大流入多出现在已经涨了的日子，别因为它去追。"}
      </p>
      {mode === "pro" && (
        <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-4">
          <Tile k="昨天净流入" v={fmtYi(n.flow)} sub={`120 天分位 ${Math.round(n.pct * 100)}%`} tone={n.flow} />
          <Tile k="近 3 日合计" v={fmtYi(n.sum3)} sub={`分位 ${Math.round(n.p3 * 100)}%`} tone={n.sum3} />
          <Tile k="近 7 日合计" v={fmtYi(n.sum7)} sub={`分位 ${Math.round(n.p7 * 100)}%`} tone={n.sum7} />
          <Tile k="占资产" v={n.aumPct == null ? "—" : `${n.aumPct > 0 ? "+" : ""}${n.aumPct.toFixed(2)}%`} sub={`累计 ${fmtYi(n.cumulative, false)} · 资产 ${fmtYi(n.aum, false)}`} tone={n.flow} />
        </div>
      )}
      {mode === "pro" && d.funds.length > 0 && (
        <p className="text-[12px] text-ink-3">
          分基金：
          {d.funds.slice(0, 6).map((f, i) => (
            <span key={f.name}>
              {i ? "，" : ""}
              {f.name} <span className={f.flow >= 0 ? "text-up" : "text-down"}>{fmtYi(f.flow)}</span>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function Tile({ k, v, sub, tone }: { k: string; v: string; sub: string; tone: number }) {
  return (
    <div className="rounded-lg bg-panel-2 px-3 py-2">
      <div className="text-[11px] text-ink-3">{k}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone > 0 ? "text-up" : tone < 0 ? "text-down" : ""}`}>{v}</div>
      <div className="text-[11px] text-ink-3">{sub}</div>
    </div>
  );
}

function RadarCard({ r, mode, facts }: { r: Radar; mode: Mode; facts: FlowsPage["facts"] }) {
  const pos = r.z == null ? 50 : Math.max(0, Math.min(100, ((r.z + 3) / 6) * 100));
  const phase =
    r.phase === "未开始" ? "盘前还没开始（北京 16:00 开始）" : r.phase === "盘前滚动" ? "盘前滚动中，北京 21:00 定盘，数字还会动" : "今天已定盘（北京 16:00–21:00 的平均）";
  const strong = r.band === "买盘强" || r.band === "偏买";
  const weak = r.band === "卖盘强" || r.band === "偏卖";
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">今天盘前雷达</h2>
        <span className="text-[12px] text-ink-3">{phase}</span>
      </div>
      {r.weekend ? (
        <p className="text-[14px] text-ink-2">今天是周末，美股休市，没有盘前雷达，也不会有新的 ETF 流入。{r.prevDay && `上一个交易日（${r.prevDay.day.slice(5)}）的盘前 Z 是 ${zStr(r.prevDay.z)}。`}</p>
      ) : r.z == null ? (
        <p className="text-[14px] text-ink-2">{r.prevDay ? `上一个交易日（${r.prevDay.day.slice(5)}）的盘前 Z 是 ${zStr(r.prevDay.z)}。` : "盘前溢价的历史还在下载。"}今天的数字北京 16:00 后出现。</p>
      ) : (
        <>
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-semibold tabular-nums">{zStr(r.z)}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${BAND_TONE(r.band)}`}>{r.band}</span>
          </div>
          <div>
            <div className="relative h-2 rounded-full" style={{ background: "linear-gradient(90deg, var(--down) 0%, var(--panel-2) 35%, var(--panel-2) 65%, var(--up) 100%)" }}>
              <i className="absolute -top-1 h-4 w-[3px] rounded bg-ink" style={{ left: `calc(${pos}% - 1px)` }} />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-ink-3">
              <span>卖盘 −3</span>
              <span>0</span>
              <span>买盘 +3</span>
            </div>
          </div>
          <p className="text-[14px] leading-relaxed">
            {strong ? "美国买盘强于平时。" : weak ? "美国买盘弱于平时。" : "美国买盘和平时差不多。"}今天 ETF 净流入的概率约 <b>{pct(r.inflowPct)}</b>（所有日子 {pct(r.baseInflowPct)}）。
          </p>
          <p className="text-[13px] text-ink-3">BTC 价格：不预测。{mode === "pro" ? facts.zPrice : "盘前溢价能预告 ETF 往哪流，预告不了价格。"}</p>
        </>
      )}
      <p className="text-[11px] leading-relaxed text-ink-3">
        Z = 今天盘前的 Coinbase 真实溢价，比它自己之前 60 个交易日的平均高（正）或低（负）几个标准差。衡量的是美国买盘比平时强多少，不是溢价绝对高低。
      </p>
    </section>
  );
}

function Schedule() {
  const rows: [string, string][] = [
    ["16:00 起", "美股盘前，雷达开始滚动"],
    ["21:00", "盘前 Z 定盘"],
    ["21:30", "美股开盘（冬令时 22:30）"],
    ["次日 6–9 点", "昨天的流入数字出来，部分基金更晚，之后还可能修正"],
    ["美国节假日", "没有新流入，雷达照常算但没有对应的流入"],
  ];
  return (
    <section className="card space-y-2 p-4">
      <h2 className="text-base font-semibold">什么时候看什么（北京时间）</h2>
      <div className="divide-y divide-line text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3 py-1.5">
            <span className="w-24 shrink-0 font-semibold tabular-nums">{k}</span>
            <span className="text-ink-2">{v}</span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-ink-3">ETF 只在美股交易时间申购赎回，所以流入是“隔天才知道”的数字；盘前雷达是当天唯一能提前看的东西。</p>
    </section>
  );
}

function FlowChart({ d }: { d: FlowsPage }) {
  const [range, setRange] = useState<30 | 90 | 365>(90);
  // draw at the box's real width so the axis labels stay readable on a phone
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(900);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bars = d.bars.slice(-range);
  const H = W < 600 ? 220 : 260;
  const L = 52;
  const R = 40;
  const T = 10;
  const B = 24;
  const pw = W - L - R;
  const ph = H - T - B;
  const fMax = Math.max(1, ...bars.map((b) => b.flow));
  const fMin = Math.min(0, ...bars.map((b) => b.flow));
  const prices = bars.map((b) => b.price).filter((x): x is number => x != null);
  const pMin = Math.min(...prices) * 0.98;
  const pMax = Math.max(...prices) * 1.02;
  const yF = (v: number) => T + ((fMax - v) / (fMax - fMin)) * ph;
  const yP = (v: number) => T + ((pMax - v) / (pMax - pMin)) * ph;
  const step = pw / bars.length;
  const bw = Math.max(1, step * 0.72);
  const line = bars
    .map((b, i) => (b.price == null ? null : `${(L + i * step + step / 2).toFixed(1)},${yP(b.price).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  const ticks = [fMin, 0, fMax].filter((v, i, a) => a.indexOf(v) === i);
  const every = Math.ceil(bars.length / (W < 600 ? 4 : 6));
  return (
    <section className="card space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">每日净流入和 BTC 价格</h2>
        <div className="ml-auto flex gap-1 text-[12px]">
          {([30, 90, 365] as const).map((n) => (
            <button key={n} onClick={() => setRange(n)} className={`rounded-full px-2.5 py-0.5 ${range === n ? "bg-ink text-bg" : "bg-panel-2 text-ink-2"}`}>
              近 {n} 天
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-[11px] text-ink-3">
        <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-up align-[-1px]" />净流入</span>
        <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-down align-[-1px]" />净流出</span>
        <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-accent align-[-1px]" />BTC 价格（右轴，美东收盘时）</span>
      </div>
      <div ref={box} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label="每日 ETF 净流入柱和 BTC 价格线">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={yF(v)} y2={yF(v)} stroke="var(--chart-grid)" strokeWidth={v === 0 ? 1.5 : 1} />
            <text x={L - 6} y={yF(v) + 4} textAnchor="end" fontSize={11} fill="var(--text-3)">
              {fmtYi(v, false)}
            </text>
          </g>
        ))}
        {prices.length > 1 &&
          [pMin / 0.98, pMax / 1.02].map((v) => (
            <text key={v} x={W - R + 6} y={yP(v) + 4} fontSize={11} fill="var(--accent)">
              {(v / 1000).toFixed(0)}k
            </text>
          ))}
        {bars.map((b, i) => {
          const y0 = yF(0);
          const y1 = yF(b.flow);
          return (
            <rect key={b.day} x={L + i * step + (step - bw) / 2} y={Math.min(y0, y1)} width={bw} height={Math.max(1, Math.abs(y1 - y0))} fill={b.flow >= 0 ? "var(--up)" : "var(--down)"} rx={1}>
              <title>{`${b.day} 净${b.flow >= 0 ? "流入" : "流出"} ${fmtYi(Math.abs(b.flow), false)}美元${b.price ? `，BTC ${Math.round(b.price).toLocaleString("en-US")}` : ""}`}</title>
            </rect>
          );
        })}
        {line && <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={1.8} strokeLinejoin="round" />}
        {bars.map((b, i) =>
          i % every === 0 ? (
            <text key={b.day} x={L + i * step + step / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--text-3)">
              {range === 365 ? b.day.slice(2, 7) : b.day.slice(5).replace("-", "/")}
            </text>
          ) : null,
        )}
      </svg>
      </div>
      <p className="text-[12px] text-ink-3">把手指 / 鼠标放在柱子上看当天数字。大柱子多半和价格一起出现，这是“跟着走”，不是“提前说”。</p>
    </section>
  );
}

function AfterCells({ rows }: { rows: AfterRow[] }) {
  return (
    <>
      {rows.map((r) => (
        <td key={r.days} className="px-2 py-1.5 text-right tabular-nums">
          {r.n ? (
            <>
              <span className={r.avgPct > 0 ? "text-up" : r.avgPct < 0 ? "text-down" : ""}>{signedPct(r.avgPct)}</span>
              <span className="text-ink-3"> · 涨 {pct(r.upPct)}</span>
            </>
          ) : (
            "—"
          )}
        </td>
      ))}
    </>
  );
}

function Similar({ d }: { d: FlowsPage }) {
  const s = d.similar;
  const n = s.rows[0]?.n ?? 0;
  return (
    <section className="card space-y-2 p-4">
      <h2 className="text-base font-semibold">历史上像昨天的日子</h2>
      <p className="text-[12px] text-ink-3">
        {s.label}，从第二天北京 21:00（数字已经公布）起算之后的涨跌，旁边是所有日子的对照。共 {n} 次。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[11px] text-ink-3">
              <th className="px-2 py-1 text-left font-normal"></th>
              <th className="px-2 py-1 text-right font-normal">1 天后</th>
              <th className="px-2 py-1 text-right font-normal">3 天后</th>
              <th className="px-2 py-1 text-right font-normal">7 天后</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line">
              <td className="px-2 py-1.5">{s.band}</td>
              <AfterCells rows={s.rows} />
            </tr>
            <tr className="border-t border-line text-ink-2">
              <td className="px-2 py-1.5">所有日子</td>
              <AfterCells rows={s.all} />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-ink-3">差别看起来有，但次数少、前后两段不一致：E26 用同期随机对照检验过，没有一种达标。只当背景。</p>
    </section>
  );
}

function Follows({ d }: { d: FlowsPage }) {
  const f = d.follows;
  const max = Math.max(1, ...f.bySameDay.map((q) => Math.abs(q.mean)), ...f.byNextDay.map((q) => Math.abs(q.mean)));
  const Row = ({ label, qs }: { label: string; qs: FlowsPage["follows"]["bySameDay"] }) => (
    <div className="space-y-1">
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className="grid grid-cols-5 items-end gap-1" style={{ height: 70 }}>
        {qs.map((q, i) => (
          <div key={i} className="flex h-full flex-col justify-end" title={`${signedPct(q.lo, 1)} 到 ${signedPct(q.hi, 1)}：平均 ${fmtYi(q.mean)}，${q.n} 天`}>
            <div className={q.mean >= 0 ? "bg-up" : "bg-down"} style={{ height: `${Math.max(2, (Math.abs(q.mean) / max) * 100)}%`, borderRadius: 2 }} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1 text-center text-[10px] text-ink-3">
        <span>跌最多</span>
        <span></span>
        <span>中间</span>
        <span></span>
        <span>涨最多</span>
      </div>
    </div>
  );
  return (
    <section className="card space-y-3 p-4">
      <h2 className="text-base font-semibold">流入跟着价格走</h2>
      <p className="text-[12px] text-ink-3">
        按当天 / 第二天的涨跌把 {f.days} 个交易日分五档，看每档的平均净流入。相关系数：和当天 {f.sameDay.toFixed(2)}，和之前 5 天 {f.prev5.toFixed(2)}，和之后 1 天 {f.next1.toFixed(2)}，和之后 7 天 {f.next7.toFixed(2)}。
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Row label="按当天涨跌分档" qs={f.bySameDay} />
        <Row label="按第二天涨跌分档" qs={f.byNextDay} />
      </div>
      <p className="text-[12px] text-ink-3">左边一档比一档高：涨得多的日子流入多。右边没有这个规律：今天的流入说明不了明天。</p>
    </section>
  );
}

function PremiumCard({ r }: { r: Radar }) {
  const m = r.minutes;
  const h = r.history;
  const W = 600;
  const Hh = 110;
  const spark = (pts: [number, number][], key: string) => {
    if (pts.length < 2) return <p className="text-[12px] text-ink-3">数据还不够画图。</p>;
    const ys = pts.map((p) => p[1]);
    const lo = Math.min(...ys, 0);
    const hi = Math.max(...ys, 0);
    const X = (i: number) => (i / (pts.length - 1)) * W;
    const Y = (v: number) => 6 + ((hi - v) / (hi - lo || 1)) * (Hh - 12);
    return (
      <svg key={key} viewBox={`0 0 ${W} ${Hh}`} className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="溢价走势">
        <line x1={0} x2={W} y1={Y(0)} y2={Y(0)} stroke="var(--text-3)" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" points={pts.map((p, i) => `${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")} />
      </svg>
    );
  };
  return (
    <section className="card space-y-3 p-4">
      <h2 className="text-base font-semibold">真实溢价 · Z 的原料</h2>
      {r.live ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className={`text-2xl font-semibold tabular-nums ${r.live.prem >= 0 ? "text-up" : "text-down"}`}>{bp(r.live.prem)}</span>
            <span className="text-[12px] text-ink-3">
              名义溢价 {bp(r.live.nominal)}，减去 USDT 脱锚 {bp(r.live.usdtDev)} · {fmtBj(r.live.t * 1000)}
            </span>
          </div>
          <p className="text-[12px] text-ink-3">
            Coinbase {r.live.cb.toLocaleString("en-US", { maximumFractionDigits: 2 })} · Binance {r.live.bn.toLocaleString("en-US", { maximumFractionDigits: 2 })}（USDT）· USDT = {r.live.usdt} 美元
          </p>
        </div>
      ) : (
        <p className="text-[12px] text-ink-3">实时采样还没开始或暂时中断（每分钟一次）。</p>
      )}
      <p className="text-[12px] text-ink-3">名义溢价 = Coinbase 美元价比 Binance USDT 价高多少；里面一部分是 USDT 偏离 1 美元，和 ETF 无关，扣掉后剩下的才是美国买盘。</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="text-[12px] text-ink-2">最近几小时（每分钟一个点）</div>
          {spark(m, "m")}
        </div>
        <div>
          <div className="text-[12px] text-ink-2">盘前溢价日频，近 {h.length} 个交易日</div>
          {spark(h.map((x) => [0, x.prem]), "h")}
        </div>
      </div>
    </section>
  );
}

function ZTable({ r }: { r: Radar }) {
  return (
    <section className="card space-y-2 p-4">
      <h2 className="text-base font-semibold">Z 落在哪一档，历史上怎样</h2>
      <p className="text-[12px] text-ink-3">服务器上的 {r.tableDays} 个交易日，每天更新。美股时段 = 北京 21:00 → 次日 04:00。</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[13px]">
          <thead>
            <tr className="text-[11px] text-ink-3">
              <th className="px-2 py-1 text-left font-normal">Z</th>
              <th className="px-2 py-1 text-right font-normal">天数</th>
              <th className="px-2 py-1 text-right font-normal">当天 ETF 净流入</th>
              <th className="px-2 py-1 text-right font-normal">美股时段 BTC 上涨</th>
              <th className="px-2 py-1 text-right font-normal">平均</th>
            </tr>
          </thead>
          <tbody>
            {r.table.map((x) => (
              <tr key={x.band} className={`border-t border-line ${x.band === r.band ? "bg-accent-soft" : ""} ${x.band === "所有日子" ? "text-ink-3" : ""}`}>
                <td className="px-2 py-1.5">
                  {x.label}
                  {x.band !== "所有日子" && <span className="text-ink-3"> · {x.band}</span>}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{x.days}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{pct(x.inflowPct)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{pct(x.upPct)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{signedPct(x.avgPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-ink-3">“当天 ETF 净流入”这一列是盘前雷达真正能用的部分。价格两列是候选，未达标：换个时间点或回看天数就不显著（E26 / E26b），不当信号。</p>
    </section>
  );
}

function HowToUse({ d, mode }: { d: FlowsPage; mode: Mode }) {
  return (
    <section className="card space-y-2 p-4">
      <h2 className="text-base font-semibold">怎么用这一页</h2>
      <ol className="list-decimal space-y-1 pl-5 text-[14px] leading-relaxed text-ink-2">
        <li>把它当背景：现在美国这边是在买还是在卖。</li>
        <li>不要因为一天的大流入去追：{d.facts.flowFollowsPrice.replace("大额流入多出现在已经涨了的日子：", "").replace("资金是跟着价格走的，别因为一天的大流入去追。", "资金是跟着价格走的。")}</li>
        <li>买卖点、止损和仓位，仍然看“趋势与计划”和“实时盯盘”。</li>
      </ol>
      {mode === "pro" && (
        <ul className="list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-ink-3">
          <li>{d.facts.comboNoEdge}</li>
          <li>{d.facts.precursor}</li>
          <li>{d.facts.delay}</li>
        </ul>
      )}
    </section>
  );
}
