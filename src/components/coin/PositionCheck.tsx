"use client";

import { useEffect, useMemo, useState } from "react";
import type { TrendPlan } from "@/lib/trendplan";
import { MMR } from "@/lib/ta/plan";
import { useCoins } from "../coins-context";
import { TF_LABEL } from "@/lib/types";
import { Term } from "../Term";
import { track } from "../track";
import { fmtPrice } from "./format";
import { fmtR, noiseAt, readPref, returnCorrelation, structureStop } from "./plan-ui";
import { Section } from "./shared";

/**
 * Health check of positions the visitor enters by hand. They stay in this browser
 * (localStorage) and are never sent anywhere; only the public plan of each coin is fetched.
 */

interface Position {
  id: string;
  coin: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  /** position value at entry, USDT */
  notional: number;
  leverage: number | null;
}

const KEY = "sl-positions-v1";

function load(): Position[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.coin === "string" && x.entry > 0 && x.stop > 0 && x.notional > 0) : [];
  } catch {
    return [];
  }
}

function save(list: Position[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

export function PositionCheck({ current }: { current: TrendPlan }) {
  const [list, setList] = useState<Position[]>([]);
  const [plans, setPlans] = useState<Record<string, TrendPlan>>({});
  const [adding, setAdding] = useState(false);
  useEffect(() => setList(load()), []);

  // the 4-hour plan of every held coin (the page's own when it is the one shown)
  const coins = useMemo(() => [...new Set(list.map((x) => x.coin))].sort().join(","), [list]);
  useEffect(() => {
    if (!coins) return;
    let alive = true;
    const get = () =>
      Promise.all(
        coins.split(",").map((c) =>
          fetch(`/api/plan?coin=${c}&fw=4h`)
            .then((r) => r.json())
            .then((b) => (b && !b.error ? ([c, b] as const) : null))
            .catch(() => null),
        ),
      ).then((rows) => alive && setPlans(Object.fromEntries(rows.filter((x): x is readonly [string, TrendPlan] => !!x))));
    get();
    const id = setInterval(get, 120_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [coins]);
  const planOf = (coin: string) => (current.framework === "4h" && current.coin === coin && !current.replay ? current : plans[coin]);

  const update = (next: Position[]) => {
    setList(next);
    save(next);
    track("check_position", "positions");
  };

  const capital = readPref("capital", 0);
  const rows = list.map((x) => ({ x, p: planOf(x.coin), a: planOf(x.coin) ? assess(x, planOf(x.coin)!) : null }));
  const totalRisk = rows.reduce((s, r) => s + Math.max(0, r.a?.openRisk ?? 0), 0);
  const groups = (["long", "short"] as const)
    .map((side) => {
      const held = rows.filter((r) => r.x.side === side && r.p);
      const names = [...new Set(held.map((r) => r.x.coin))];
      if (names.length < 2) return null;
      const cs: number[] = [];
      for (let i = 0; i < names.length; i++)
        for (let j = i + 1; j < names.length; j++) {
          const v = returnCorrelation(planOf(names[i])!.daily, planOf(names[j])!.daily);
          if (v != null) cs.push(v);
        }
      return { side, names, corr: cs.length ? cs.reduce((s, v) => s + v, 0) / cs.length : null, risk: held.reduce((s, r) => s + Math.max(0, r.a?.openRisk ?? 0), 0) };
    })
    .filter((g): g is NonNullable<typeof g> => !!g);

  return (
    <Section title={<>持仓体检 <span className="text-xs font-normal text-ink-3">（只存在你的浏览器里）</span></>}>
      {list.length === 0 && !adding && <p className="text-[13px] leading-relaxed text-ink-3">把手上的合约仓位填进来，按 4 小时结构检查：结构是否完好、止损会不会被正常波动扫到、认错位该不该移动、几笔同方向的仓位加起来冒了多大风险。</p>}
      <ul className="space-y-2.5">
        {rows.map(({ x, p, a }) => (
          <li key={x.id} className="rounded-lg bg-panel-2 p-3 text-[13px] leading-relaxed">
            <div className="flex items-center gap-2">
              <b>{x.coin}</b>
              <span style={{ color: x.side === "long" ? "var(--up)" : "var(--down)" }}>{x.side === "long" ? "多" : "空"}</span>
              <span className="num text-ink-3">
                {fmtPrice(x.entry)} → 止损 {fmtPrice(x.stop)} · {Math.round(x.notional).toLocaleString("en-US")} U{x.leverage ? ` · ${x.leverage}x` : ""}
              </span>
              <button className="ml-auto text-[11px] text-ink-3 hover:text-down" onClick={() => update(list.filter((y) => y.id !== x.id))}>
                删除
              </button>
            </div>
            {!p || !a ? (
              <p className="text-ink-3">正在读取 {x.coin} 的结构…</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-ink-2">
                <li>
                  现价 <span className="num">{fmtPrice(p.price)}</span>，浮动 <b className="num" style={{ color: a.pnl >= 0 ? "var(--up)" : "var(--down)" }}>{a.pnl >= 0 ? "+" : ""}{a.pnl.toFixed(0)} U</b>
                  {a.r != null && <span className="text-ink-3">（{fmtR(a.r)}）</span>}
                </li>
                {a.notes.map((n) => (
                  <li key={n.text} style={{ color: n.tone === "bad" ? "var(--down)" : n.tone === "warn" ? "var(--warn)" : n.tone === "good" ? "var(--up)" : undefined }}>
                    {n.tone === "bad" ? "✗ " : n.tone === "warn" ? "⚠ " : n.tone === "good" ? "✓ " : "· "}
                    {n.text}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {list.length > 0 && (
        <div className="mt-3 space-y-1 rounded-lg border border-line p-3 text-[13px] leading-relaxed">
          <div>
            全部打到止损还会亏 <b className="num text-down">{totalRisk.toFixed(0)} U</b>
            {capital > 0 && <span className="text-ink-3">（总资金 {capital.toLocaleString("en-US")} U 的 {((totalRisk / capital) * 100).toFixed(1)}%）</span>}
          </div>
          {capital > 0 && totalRisk / capital > 0.06 && <div className="text-warn">⚠ 合计风险超过总资金的 6%：一起被扫的时候伤得很重，考虑减仓。</div>}
          {groups.map((g) => (
            <div key={g.side} className="text-warn">
              ⚠ {g.names.join("、")} 同时{g.side === "long" ? "做多" : "做空"}
              {g.corr != null && <>：最近 90 天日涨跌的相关系数平均 {g.corr.toFixed(2)}</>}
              。这几笔会一起赚、一起亏，合起来是一笔约 {g.risk.toFixed(0)} U 风险的大单（<Term k="相关性">为什么</Term>）。
            </div>
          ))}
          {capital <= 0 && <div className="text-[11px] text-ink-3">在“按计划算仓位”里填上总资金，这里会换算成占总资金的比例。</div>}
        </div>
      )}

      {adding ? (
        <AddForm defaultCoin={current.coin} price={current.price} onCancel={() => setAdding(false)} onAdd={(x) => (update([...list, x]), setAdding(false))} />
      ) : (
        <button className="mt-3 text-xs text-accent" onClick={() => setAdding(true)}>
          + 添加一笔持仓
        </button>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">结构按 {TF_LABEL["4h"]} 判断、方向按日线判断。仓位只保存在这个浏览器，换设备或清缓存会丢失；页面不会上传你的持仓。</p>
    </Section>
  );
}

type Note = { text: string; tone: "good" | "warn" | "bad" | "info" };

/** Everything the check says about one position. */
function assess(x: Position, p: TrendPlan) {
  const dir = x.side === "long" ? 1 : -1;
  const price = p.price;
  const qty = x.notional / x.entry;
  const risk0 = (x.entry - x.stop) * dir;
  const pnl = qty * (price - x.entry) * dir;
  const openRisk = qty * (price - x.stop) * dir;
  const notes: Note[] = [];
  const view = p.map.find((m) => m.role === "entry")!.view;
  const fdir = p.map.find((m) => m.role === "filter")!.direction;
  const trend = dir > 0 ? "up" : "down";
  const TF = TF_LABEL[p.tf];

  if ((price - x.stop) * dir <= 0) {
    // past the stop there is nothing to adjust: suggesting a new stop now would teach moving stops away
    notes.push({ text: "现价已经越过你的止损价：按计划这笔应该已经离场。别把止损往外挪。", tone: "bad" });
    return { pnl, r: risk0 > 0 ? ((price - x.entry) * dir) / risk0 : null, openRisk, notes };
  }
  if (view.state === trend) {
    if (view.breach === "broken") notes.push({ text: `${TF}${dir > 0 ? "上升" : "下降"}结构已失效（收盘越过保护位 0.8 倍 ATR）：按计划规则这里该离场。`, tone: "bad" });
    else if (view.breach === "pierced") notes.push({ text: `${TF}结构的保护位被刺穿（收盘越过 0.1 倍 ATR）：观察，别加仓。`, tone: "warn" });
    else notes.push({ text: `${TF}${dir > 0 ? "上升" : "下降"}结构完好。`, tone: "good" });
  } else if (view.state === (dir > 0 ? "down" : "up")) notes.push({ text: `${TF}是${dir > 0 ? "下降" : "上升"}结构：这是逆着结构的仓位。`, tone: "warn" });
  else notes.push({ text: `${TF}是${view.label}：方向还没走出来。`, tone: "info" });
  if (fdir === -dir) notes.push({ text: `逆着日线方向：按计划规则只该用半仓。`, tone: "warn" });

  const k = ((price - x.stop) * dir) / p.atr;
  if (k > 0) {
    const n = noiseAt(p, k);
    notes.push({ text: `止损离现价 ${k.toFixed(1)} 倍 ATR${n != null ? `，正常波动 ${p.noiseHorizon} 内碰到它的概率约 ${n}%` : ""}。`, tone: n != null && n >= 60 ? "warn" : "info" });
  }

  const st = structureStop(p, dir);
  if (st && (price - st.stop) * dir > 0) {
    const word = dir > 0 ? "下方" : "上方";
    if ((st.stop - x.stop) * dir > 0.05 * p.atr)
      notes.push({ text: `可以把止损移到 ${fmtPrice(st.stop)}（最近的${dir > 0 ? "低点" : "高点"} ${fmtPrice(st.anchor)} ${word} ${p.buffers.p80.toFixed(2)} 倍 ATR）：只收紧、不放松。`, tone: "good" });
    else if ((x.stop - st.stop) * dir > 0.05 * p.atr)
      notes.push({
        text: `你的止损在结构认错位以内，容易被正常波动扫掉。结构认错位在 ${fmtPrice(st.stop)}（${dir > 0 ? "低点" : "高点"} ${fmtPrice(st.anchor)} ${word}）：下次开仓就放在那里、按距离把仓位做小；已经开的仓，别只把止损挪远而不减仓。`,
        tone: "warn",
      });
  }

  if (x.leverage && x.leverage > 1) {
    const liq = x.entry * (1 - dir * (1 / x.leverage - MMR));
    if ((x.stop - liq) * dir <= 0) notes.push({ text: `${x.leverage} 倍下强平价约 ${fmtPrice(liq)}，在止损之前：还没到认错位就会被强平。`, tone: "bad" });
  }
  return { pnl, r: risk0 > 0 ? ((price - x.entry) * dir) / risk0 : null, openRisk, notes };
}

function AddForm({ defaultCoin, price, onAdd, onCancel }: { defaultCoin: string; price: number; onAdd: (x: Position) => void; onCancel: () => void }) {
  const coins = useCoins();
  const [coin, setCoin] = useState(defaultCoin);
  const [side, setSide] = useState<"long" | "short">("long");
  const [entry, setEntry] = useState(coin === defaultCoin ? +price.toPrecision(6) : 0);
  const [stop, setStop] = useState(0);
  const [notional, setNotional] = useState(1000);
  const [lev, setLev] = useState(0);
  const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";
  const ok = entry > 0 && stop > 0 && notional > 0 && (side === "long" ? stop < entry : stop > entry);
  return (
    <div className="mt-3 space-y-2.5 rounded-lg border border-line p-3 text-xs text-ink-3">
      <div className="grid grid-cols-2 gap-2.5">
        <label className="space-y-1">
          <span>币种</span>
          <select className={field} value={coin} onChange={(e) => setCoin(e.target.value)}>
            {coins.map((c) => (
              <option key={c.id} value={c.id}>{c.id}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span>方向</span>
          <select className={field} value={side} onChange={(e) => setSide(e.target.value as "long" | "short")}>
            <option value="long">做多</option>
            <option value="short">做空</option>
          </select>
        </label>
        <label className="space-y-1">
          <span>开仓价</span>
          <input type="number" className={field} value={entry || ""} onChange={(e) => setEntry(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>止损价</span>
          <input type="number" className={field} value={stop || ""} onChange={(e) => setStop(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>仓位价值 (USDT)</span>
          <input type="number" className={field} value={notional || ""} onChange={(e) => setNotional(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>杠杆（可不填）</span>
          <input type="number" className={field} value={lev || ""} onChange={(e) => setLev(+e.target.value)} />
        </label>
      </div>
      {!ok && entry > 0 && stop > 0 && <p className="text-down">{side === "long" ? "做多的止损要低于开仓价。" : "做空的止损要高于开仓价。"}</p>}
      <div className="flex gap-2">
        <button
          disabled={!ok}
          className="rounded-lg bg-ink px-3 py-1.5 text-bg disabled:opacity-40"
          onClick={() => onAdd({ id: Math.random().toString(36).slice(2), coin, side, entry, stop, notional, leverage: lev > 0 ? lev : null })}
        >
          加入体检
        </button>
        <button className="rounded-lg border border-line px-3 py-1.5" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
