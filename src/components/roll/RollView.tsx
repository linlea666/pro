"use client";

import { useEffect, useMemo, useState } from "react";
import type { TrendPlan } from "@/lib/trendplan";
import {
  cutPlan,
  DEFAULT_FEE,
  fundingCost,
  liquidationPrice,
  maxAdd,
  nextAddLevel,
  pnlAt,
  positionOf,
  previewAdd,
  previewReduce,
  ROLL_RULES,
  rollStatus,
  trimQty,
  type AddLimit,
  type Dir,
  type Fill,
  type MarginMode,
  type Position,
  type Tone,
} from "@/lib/ta/roll";
import type { CoinMeta } from "@/lib/symbols";
import { fmtPrice } from "../coin/format";
import { structureStop } from "../coin/plan-ui";
import { track } from "../track";

/**
 * 滚仓助手: positions entered by hand, grouped by account, with the price ladder, how much
 * may be added under the risk budget, and where to take some off. Everything stays in this
 * browser (localStorage); only public prices and plans are fetched. Nothing is ordered.
 */

interface Holding {
  id: string;
  coin: string;
  dir: Dir;
  mode: MarginMode;
  leverage: number;
  fills: Fill[];
  /** null: use the plan's structure stop */
  stop: number | null;
  targets: number[];
  /** closed profit carried over when the fills were replaced by the exchange's figures */
  realizedBase: number;
  example?: boolean;
}

interface Account {
  id: string;
  name: string;
  /** account total, USDT */
  total: number;
  /** risk budget per position, % of the account */
  riskPct: number;
  /** keep: the whole position may lose the budget at the stop; even: it must not lose after an add */
  budget: "keep" | "even";
  fee: number;
  holdings: Holding[];
}

const KEY = "sl-roll-v1";
const uid = () => Math.random().toString(36).slice(2, 10);

const EXAMPLE: Account = {
  id: "example",
  name: "示例账户",
  total: 10000,
  riskPct: 2,
  budget: "keep",
  fee: DEFAULT_FEE.taker,
  holdings: [{ id: "ex1", coin: "ETH", dir: 1, mode: "isolated", leverage: 10, fills: [{ kind: "open", price: 2300, qty: 4 }], stop: 2250, targets: [2350, 2400], realizedBase: 0, example: true }],
};

function load(): Account[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return Array.isArray(v) && v.every((a) => a && typeof a.id === "string" && Array.isArray(a.holdings)) ? v : null;
  } catch {
    return null;
  }
}
function save(list: Account[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";
const money = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
const toneColor = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink-3");
const TONE_BG: Record<Tone, string> = { good: "bg-up-soft", wait: "bg-panel-2", warn: "bg-warn-soft", bad: "bg-down-soft" };
const BINDING: Record<AddLimit["binding"], string> = {
  budget: "风险预算",
  pyramid: `金字塔（不超过上一笔的 ${ROLL_RULES.pyramid * 100}%）`,
  liquidation: `强平距离（止损要在强平前 ${ROLL_RULES.liqGapAtr} 倍 ATR）`,
  leverage: `实际杠杆不超过 ${ROLL_RULES.maxLeverage} 倍`,
  count: `最多加 ${ROLL_RULES.maxAdds} 次`,
  losing: "浮亏中不加仓",
  stop: "止损在现价另一边",
};

interface Live {
  price: number | null;
  plan: TrendPlan | null;
  funding: number | null;
}

/** Prices every 15 s, the 4-hour plan every 2 min, funding every 5 min, for the coins held. */
function useLive(coins: string[]): Record<string, Live> {
  const [live, setLive] = useState<Record<string, Live>>({});
  const key = coins.join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const list = key.split(",");
    const put = (c: string, patch: Partial<Live>) => alive && setLive((m) => ({ ...m, [c]: { ...({ price: null, plan: null, funding: null } as Live), ...m[c], ...patch } }));
    const json = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
    const price = () => list.forEach((c) => json(`/api/price?coin=${c}`).then((b) => b?.price > 0 && put(c, { price: b.price })));
    const plan = () => list.forEach((c) => json(`/api/plan?coin=${c}&fw=4h`).then((b) => b && !b.error && put(c, { plan: b })));
    const perp = () => list.forEach((c) => json(`/api/perp?coin=${c}`).then((b) => b?.status === "ok" && put(c, { funding: b.perp.fundingRate })));
    price();
    plan();
    perp();
    const ids = [setInterval(() => !document.hidden && price(), 15_000), setInterval(() => !document.hidden && plan(), 120_000), setInterval(() => !document.hidden && perp(), 300_000)];
    return () => {
      alive = false;
      ids.forEach(clearInterval);
    };
  }, [key]);
  return live;
}

/** Everything the page shows about one holding, from its fills and the live data. */
function analyse(h: Holding, acc: Account, l: Live | undefined) {
  const pos = positionOf(h.dir, h.fills, acc.fee);
  pos.realized += h.realizedBase;
  const plan = l?.plan ?? null;
  const price = l?.price ?? plan?.price ?? null;
  const atr = plan?.atr ?? null;
  const st = plan ? structureStop(plan, h.dir) : null;
  const stop = h.stop ?? st?.stop ?? null;
  const liq = liquidationPrice({ dir: h.dir, qty: pos.qty, avg: pos.avg, mode: h.mode, leverage: h.leverage, account: acc.total });
  const levels = (plan?.levels ?? []).map((x) => x.price);
  const budget = acc.budget === "even" ? 0 : (acc.total * acc.riskPct) / 100;
  const add = (at: number) => (stop != null ? maxAdd({ pos, price: at, stop, budget, mode: h.mode, leverage: h.leverage, account: acc.total, atr, fee: acc.fee }) : null);
  // the next level is where to add after a close beyond it while adding is still allowed; otherwise it is the first cut
  const next = price != null ? nextAddLevel(h.dir, price, levels) : null;
  const canAdd = next != null && (add(next)?.qty ?? 0) > 0;
  const cuts = price != null ? cutPlan(pos, price, canAdd ? levels.filter((x) => h.dir * (x - next!) > 0) : levels, acc.fee) : [];
  const addLevel = canAdd || (next != null && !cuts.some((c) => c.price === next)) ? next : null;
  const status = price != null ? rollStatus({ pos, price, stop, liq, atr, cuts, addLevel, fee: acc.fee }) : null;
  const open = price != null ? pnlAt(pos, price, acc.fee) : null;
  const atStop = stop != null && pos.qty > 0 ? pnlAt(pos, stop, acc.fee) : null;
  const fundDay = l?.funding != null && price != null ? fundingCost(h.dir, pos.qty * price, l.funding, 3) : null;
  return { pos, plan, price, atr, st, stop, liq, levels, cuts, addLevel, budget, add, status, open, atStop, fundDay, funding: l?.funding ?? null };
}
type View = ReturnType<typeof analyse>;

export function RollView({ coins }: { coins: CoinMeta[] }) {
  const [accounts, setAccounts] = useState<Account[]>([EXAMPLE]);
  const [accId, setAccId] = useState(EXAMPLE.id);
  const [holdId, setHoldId] = useState<string | null>("ex1");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const v = load();
    if (v?.length) {
      setAccounts(v);
      setAccId(v[0].id);
      setHoldId(v[0].holdings[0]?.id ?? null);
    }
    track("view_roll", "roll");
  }, []);

  const update = (next: Account[]) => {
    setAccounts(next);
    save(next);
    track("use_roll", "roll");
  };
  const acc = accounts.find((a) => a.id === accId) ?? accounts[0];
  const setAcc = (patch: Partial<Account>) => update(accounts.map((a) => (a.id === acc.id ? { ...a, ...patch } : a)));
  const setHolding = (id: string, patch: Partial<Holding>) => setAcc({ holdings: acc.holdings.map((h) => (h.id === id ? { ...h, ...patch, example: false } : h)) });

  const held = useMemo(() => [...new Set(accounts.flatMap((a) => a.holdings.map((h) => h.coin)))].sort(), [accounts]);
  const live = useLive(held);
  const views = acc ? acc.holdings.map((h) => [h, analyse(h, acc, live[h.coin])] as const) : [];
  const cur = views.find(([h]) => h.id === holdId) ?? views[0];

  if (!acc) return null;
  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold">滚仓助手</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
          填上你已经开的合约仓位，这里告诉你：现在赚多少、离止损和强平多远、下一次能在哪里加多少、加完均价和打到止损的结果、到哪里该减。页面不下单，也不预测涨跌：滚仓只是让你在大行情里拿得更重，小行情里可能把小赚变成小亏。
        </p>
      </header>

      <AccountBar accounts={accounts} acc={acc} onPick={(id) => { setAccId(id); setHoldId(accounts.find((a) => a.id === id)?.holdings[0]?.id ?? null); }} onChange={setAcc} onAdd={() => {
        const a: Account = { id: uid(), name: `账户 ${accounts.length + 1}`, total: 10000, riskPct: 2, budget: "keep", fee: DEFAULT_FEE.taker, holdings: [] };
        update([...accounts.filter((x) => x.id !== EXAMPLE.id || x.holdings.some((h) => !h.example)), a]);
        setAccId(a.id);
        setHoldId(null);
      }} onRemove={() => {
        const next = accounts.filter((a) => a.id !== acc.id);
        update(next.length ? next : [EXAMPLE]);
        setAccId((next[0] ?? EXAMPLE).id);
        setHoldId((next[0] ?? EXAMPLE).holdings[0]?.id ?? null);
      }} />

      <AccountRisk acc={acc} views={views.map(([h, v]) => [h, v])} />

      <div className="flex flex-wrap items-center gap-2">
        {views.map(([h, v]) => (
          <button key={h.id} className="chip num" data-active={cur?.[0].id === h.id} onClick={() => setHoldId(h.id)}>
            {h.coin} {h.dir > 0 ? "多" : "空"} {v.open != null && <span className={cur?.[0].id === h.id ? "" : toneColor(v.open + v.pos.realized)}>{money(v.open + v.pos.realized)}</span>}
            {h.example && " · 示例"}
          </button>
        ))}
        <button className="text-sm text-accent" onClick={() => setAdding(true)}>+ 添加持仓</button>
      </div>

      {adding && (
        <HoldingForm coins={coins.map((c) => c.id)} price={(c) => live[c]?.price ?? null} onCancel={() => setAdding(false)} onAdd={(h) => {
          setAcc({ holdings: [...acc.holdings.filter((x) => !x.example), h] });
          setHoldId(h.id);
          setAdding(false);
        }} />
      )}

      {cur ? (
        <HoldingCard key={cur[0].id} h={cur[0]} v={cur[1]} acc={acc} onChange={(p) => setHolding(cur[0].id, p)} onRemove={() => setAcc({ holdings: acc.holdings.filter((x) => x.id !== cur[0].id) })} />
      ) : (
        !adding && <div className="card p-6 text-sm text-ink-3">这个账户还没有持仓。点“添加持仓”，填上币种、方向、开仓价和数量。</div>
      )}

      <Rules />
      <p className="text-[11px] leading-relaxed text-ink-3">
        账户和持仓只保存在这个浏览器（换设备或清缓存会丢失），页面不会上传。强平价按维持保证金率 0.5% 估算、不含平仓手续费和资金费，以交易所显示为准。页面上的止损请在交易所挂好，提醒不能代替止损单。
      </p>
    </div>
  );
}

function AccountBar({ accounts, acc, onPick, onChange, onAdd, onRemove }: { accounts: Account[]; acc: Account; onPick: (id: string) => void; onChange: (p: Partial<Account>) => void; onAdd: () => void; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {accounts.map((a) => (
          <button key={a.id} className="chip" data-active={a.id === acc.id} onClick={() => onPick(a.id)}>
            {a.name}
          </button>
        ))}
        <button className="text-sm text-accent" onClick={onAdd}>+ 添加账户</button>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs text-ink-3 sm:grid-cols-5">
        <label className="space-y-1">
          <span>账户名</span>
          <input id="acc-name" className={field} value={acc.name} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span>账户总金额 (USDT)</span>
          <input id="acc-total" type="number" className={field} value={acc.total || ""} onChange={(e) => onChange({ total: +e.target.value })} />
        </label>
        <label className="space-y-1">
          <span>每笔风险</span>
          <select id="acc-risk" className={field} value={acc.riskPct} onChange={(e) => onChange({ riskPct: +e.target.value })}>
            <option value={1}>保守 1%</option>
            <option value={2}>标准 2%</option>
            <option value={3}>积极 3%</option>
          </select>
        </label>
        <label className="space-y-1">
          <span>加仓后打到止损</span>
          <select id="acc-budget" className={field} value={acc.budget} onChange={(e) => onChange({ budget: e.target.value as Account["budget"] })}>
            <option value="keep">最多亏每笔风险</option>
            <option value="even">必须不亏（保本滚仓）</option>
          </select>
        </label>
        <label className="space-y-1">
          <span>手续费（吃单）%</span>
          <input id="acc-fee" type="number" step="0.01" className={field} value={+(acc.fee * 100).toFixed(4)} onChange={(e) => onChange({ fee: Math.max(0, +e.target.value) / 100 })} />
        </label>
      </div>
      <div className="text-xs">
        {confirm ? (
          <span className="space-x-3">
            <span className="text-down">删除“{acc.name}”和下面所有持仓？</span>
            <button className="text-down underline" onClick={() => (onRemove(), setConfirm(false))}>删除</button>
            <button className="text-ink-3" onClick={() => setConfirm(false)}>取消</button>
          </span>
        ) : (
          <button className="text-ink-3" onClick={() => setConfirm(true)}>删除这个账户</button>
        )}
      </div>
    </section>
  );
}

/** All holdings at their stops at once, against the account; same-direction holdings move together. */
function AccountRisk({ acc, views }: { acc: Account; views: (readonly [Holding, View])[] }) {
  if (!views.length || !(acc.total > 0)) return null;
  const lossAt = (v: View) => (v.atStop != null ? Math.max(0, -v.atStop) : null);
  const known = views.filter(([, v]) => lossAt(v) != null);
  const total = known.reduce((s, [, v]) => s + lossAt(v)!, 0);
  const pct = (total / acc.total) * 100;
  const sides = [1, -1].map((d) => views.filter(([h]) => h.dir === d).map(([h]) => h.coin)).filter((x) => x.length > 1);
  const notional = views.reduce((s, [, v]) => s + (v.price != null ? v.pos.qty * v.price : 0), 0);
  const lev = notional / acc.total;
  return (
    <section className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      <span>
        所有持仓一起打到止损：<b className={`num ${total > 0 ? "text-down" : "text-up"}`}>{total > 0 ? `亏 ${Math.round(total).toLocaleString("en-US")} USDT（账户的 ${pct.toFixed(1)}%）` : "都不亏"}</b>
        {known.length < views.length && <span className="text-ink-3">（{views.length - known.length} 笔还没有止损）</span>}
      </span>
      <span>实际杠杆 <b className={`num ${lev > ROLL_RULES.maxLeverage ? "text-down" : ""}`}>{lev.toFixed(1)} 倍</b></span>
      {pct > 6 && <span className="text-warn">⚠ 超过账户的 6%：一起打到止损时伤得很重。</span>}
      {sides.map((s) => (
        <span key={s.join()} className="text-warn">⚠ {s.join("、")} 同方向：常常一起涨跌，等于一笔更大的单。</span>
      ))}
    </section>
  );
}

function HoldingCard({ h, v, acc, onChange, onRemove }: { h: Holding; v: View; acc: Account; onChange: (p: Partial<Holding>) => void; onRemove: () => void }) {
  const { pos, price, stop, liq, atr } = v;
  const [confirm, setConfirm] = useState(false);
  const liqPct = liq != null && price != null ? ((liq - price) / price) * 100 : null;
  const liqAtr = liq != null && price != null && atr ? Math.abs(price - liq) / atr : null;
  const record = (f: Fill, patch: Partial<Holding> = {}) => onChange({ fills: [...h.fills, { ...f, t: Math.floor(Date.now() / 1000) }], ...patch });
  return (
    <section className="card space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {h.coin} {h.dir > 0 ? "多单" : "空单"} <span className="text-sm font-normal text-ink-3">· {h.mode === "isolated" ? "逐仓" : "全仓"} {h.leverage}× {h.example && "· 示例，可以直接改或删掉"}</span>
        </h2>
        <span className="num text-sm text-ink-3">现价 {fmtPrice(price)}{v.plan && ` · 4 小时 ATR ${fmtPrice(atr)}`}</span>
      </div>

      {v.status && (
        <div className={`rounded-lg px-4 py-3 ${TONE_BG[v.status.tone]}`}>
          <div className="text-lg font-semibold">{v.status.title}</div>
          <div className="text-sm text-ink-2">{v.status.detail}</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Kpi k="已实现盈亏" v={<span className={toneColor(pos.realized)}>{money(pos.realized)}</span>} sub={`已付手续费 ${pos.fees.toFixed(1)}`} />
        <Kpi k="浮动盈亏" v={<span className={toneColor(v.open ?? 0)}>{v.open != null ? money(v.open) : "—"}</span>} sub={v.open != null && pos.qty > 0 ? `保证金收益 ${((v.open / ((pos.avg * pos.qty) / h.leverage)) * 100).toFixed(1)}%` : "已扣平仓手续费"} />
        <Kpi k="均价 · 数量" v={`${fmtPrice(pos.avg)} · ${trimQty(pos.qty)}`} sub={price != null ? `仓位价值 ${Math.round(pos.qty * price).toLocaleString("en-US")}` : ""} />
        <Kpi k="打到止损" v={<span className={toneColor(v.atStop ?? 0)}>{v.atStop != null ? money(v.atStop) : "—"}</span>} sub={v.atStop != null && acc.total > 0 ? `账户的 ${((v.atStop / acc.total) * 100).toFixed(1)}%` : "还没有止损"} />
      </div>

      <div className="space-y-1.5 text-sm">
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-ink-3">离强平</span>
          <span className="num">
            {liq == null ? "按现在的保证金不会被强平" : liqPct == null ? fmtPrice(liq) : `${liqPct.toFixed(1)}%（${fmtPrice(liq)}）${liqAtr != null ? ` · ${liqAtr.toFixed(1)} 倍 ATR` : ""}`}
            {liq != null && stop != null && h.dir * (stop - liq) <= 0 && <b className="text-down"> · 强平在止损之前，还没到止损就会被强平</b>}
          </span>
        </div>
        {liqAtr != null && <SafetyBar atr={liqAtr} />}
        {v.fundDay != null && (
          <div className="text-xs text-ink-3">
            资金费：当前费率 {((v.funding ?? 0) * 100).toFixed(4)}%，按这个费率每天{v.fundDay >= 0 ? "付" : "收"}约 {Math.abs(v.fundDay).toFixed(1)} USDT（每 8 小时结算一次，费率会变）。
          </div>
        )}
      </div>

      <Ladder h={h} v={v} />

      <div className="grid gap-4 lg:grid-cols-2">
        <AddPanel h={h} v={v} acc={acc} onRecord={(f, leverage) => record(f, { leverage })} />
        <ReducePanel v={v} acc={acc} onRecord={(f) => record(f)} />
      </div>

      <Settings h={h} v={v} onChange={onChange} />

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-2">成交记录（{h.fills.length} 笔）</summary>
        <Fills h={h} acc={acc} onChange={onChange} />
      </details>

      <div className="text-xs">
        {confirm ? (
          <span className="space-x-3">
            <span className="text-down">删除这笔持仓？</span>
            <button className="text-down underline" onClick={onRemove}>删除</button>
            <button className="text-ink-3" onClick={() => setConfirm(false)}>取消</button>
          </span>
        ) : (
          <button className="text-ink-3" onClick={() => setConfirm(true)}>删除这笔持仓</button>
        )}
      </div>
    </section>
  );
}

function Kpi({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line px-3 py-2">
      <div className="text-xs text-ink-3">{k}</div>
      <div className="num truncate text-[17px] font-semibold">{v}</div>
      {sub && <div className="num truncate text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

/** Distance to liquidation in ATR: red under 2, amber under 5, green beyond (the marker caps at 10). */
function SafetyBar({ atr }: { atr: number }) {
  const at = Math.min(10, atr) * 10;
  return (
    <div className="relative h-2 rounded-full" style={{ background: "linear-gradient(90deg, var(--down) 0 20%, var(--warn) 20% 50%, var(--up) 50% 100%)" }} aria-label={`离强平 ${atr.toFixed(1)} 倍 ATR`}>
      <i className="absolute -top-1 h-4 w-[3px] rounded bg-ink" style={{ left: `calc(${at}% - 1.5px)` }} />
    </div>
  );
}

interface Rung {
  price: number;
  label: string;
  kind: "liq" | "stop" | "avg" | "now" | "target" | "add" | "cut";
}
const DOT: Record<Rung["kind"], string> = {
  liq: "bg-down border-down",
  stop: "border-down",
  avg: "border-ink-3",
  now: "bg-accent border-accent",
  target: "border-ink-3",
  add: "border-up",
  cut: "border-warn",
};

/** The price ladder: where things happen and what the position makes there, highest price on top. */
function Ladder({ h, v }: { h: Holding; v: View }) {
  const { pos, price, stop, liq } = v;
  if (!(pos.qty > 0)) return null;
  const rungs: Rung[] = [];
  if (liq != null) rungs.push({ price: liq, label: "强平", kind: "liq" });
  if (stop != null) rungs.push({ price: stop, label: h.stop == null ? "止损（计划页的结构认错位）" : "止损", kind: "stop" });
  rungs.push({ price: pos.avg, label: "均价", kind: "avg" });
  if (price != null) rungs.push({ price, label: "现价", kind: "now" });
  for (const t of h.targets) rungs.push({ price: t, label: "你填的价位", kind: "target" });
  if (v.addLevel != null) {
    const a = v.add(v.addLevel);
    rungs.push({ price: v.addLevel, label: a && a.qty > 0 ? `收盘站上 → 最多可加 ${trimQty(a.qty)}，新均价 ${fmtPrice(a.avg)}` : `收盘站上再看加仓${a ? `（现在${BINDING[a.binding]}，加不了）` : ""}`, kind: "add" });
  }
  v.cuts.forEach((c, i) => rungs.push({ price: c.price, label: `${i ? "第二个" : "前方第一个"}关键位：减 ${trimQty(c.qty)}，落袋 ${money(c.realized)}`, kind: "cut" }));
  rungs.sort((a, b) => b.price - a.price);
  return (
    <div className="space-y-2">
      <h3 className="text-[15px] font-semibold">价格梯：到哪里、发生什么、这笔仓位赚多少</h3>
      <ol className="ml-1.5 border-l-2 border-line">
        {rungs.map((r, i) => (
          <li key={i} className={`relative grid grid-cols-[84px_1fr] items-center gap-x-3 py-1.5 pl-4 text-sm sm:grid-cols-[96px_1fr_auto] ${r.kind === "now" ? "bg-accent-soft" : ""}`}>
            <span className={`absolute -left-[7px] top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 bg-panel ${DOT[r.kind]}`} />
            <span className="num font-semibold">{fmtPrice(r.price)}</span>
            <span className={`min-w-0 ${r.kind === "now" ? "font-semibold" : ""}`}>{r.label}</span>
            <span className={`num col-start-2 sm:col-start-3 sm:text-right ${r.kind === "liq" ? "text-down" : toneColor(pnlAt(pos, r.price, 0))}`}>
              {r.kind === "liq" ? "保证金亏光" : money(pnlAt(pos, r.price))}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-ink-3">盈亏是这笔仓位到该价位全部平掉的结果，已扣平仓手续费，不含资金费和已实现部分。关键位只是“沿途可能停顿的地方”，不是会到的目标。</p>
    </div>
  );
}

function AddPanel({ h, v, acc, onRecord }: { h: Holding; v: View; acc: Account; onRecord: (f: Fill, leverage: number) => void }) {
  const [atIn, setAt] = useState(0);
  const [lev, setLev] = useState(h.leverage);
  const [stopIn, setStop] = useState(0);
  // 0: follow the page (next add level or the price, the current stop) until the visitor types
  const at = atIn > 0 ? atIn : +(v.addLevel ?? v.price ?? 0).toPrecision(6);
  const stop = stopIn > 0 ? stopIn : (v.stop ?? 0);
  const limit = stop > 0 && at > 0 ? maxAdd({ pos: v.pos, price: at, stop, budget: v.budget, mode: h.mode, leverage: lev, account: acc.total, atr: v.atr, fee: acc.fee }) : null;
  const [qty, setQty] = useState<number>(0);
  const q = qty > 0 ? qty : (limit?.qty ?? 0);
  const p = q > 0 && at > 0 ? previewAdd({ pos: v.pos, price: at, qty: q, stop: stop > 0 ? stop : null, mode: h.mode, leverage: lev, account: acc.total, fee: acc.fee }) : null;
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="text-[15px] font-semibold">加仓预览</h3>
      <div className="grid grid-cols-2 gap-2.5 text-xs text-ink-3 sm:grid-cols-4">
        <Num id="add-price" label="加仓价" value={at} onChange={setAt} />
        <Num id="add-stop" label="加完的止损" value={stop} onChange={setStop} />
        <Num id="add-qty" label={`数量${qty > 0 ? "" : "（按规则）"}`} value={qty > 0 ? qty : +(limit?.qty ?? 0).toPrecision(4)} onChange={setQty} />
        <Num id="add-lev" label="杠杆倍数" value={lev} onChange={(x) => setLev(Math.max(1, x))} />
      </div>
      {limit && (
        <p className="text-sm">
          {limit.qty > 0 ? (
            <>按规则最多加 <b className="num">{trimQty(limit.qty)}</b>（这次受“{BINDING[limit.binding]}”限制）。</>
          ) : (
            <span className="text-warn">按规则这次不加：{BINDING[limit.binding]}。</span>
          )}
        </p>
      )}
      {p && (
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Kpi k="新均价" v={fmtPrice(p.avg)} sub={`共 ${trimQty(p.qty)}`} />
          <Kpi k="新强平" v={fmtPrice(p.liq)} sub={p.margin != null ? `保证金 ${Math.round(p.margin).toLocaleString("en-US")}` : "全仓按账户算"} />
          <Kpi k="打到止损" v={<span className={toneColor(p.atStop ?? 0)}>{p.atStop != null ? money(p.atStop) : "—"}</span>} sub={p.atStop != null && acc.total > 0 ? `账户的 ${((p.atStop / acc.total) * 100).toFixed(1)}%` : ""} />
          <Kpi k="止损在强平前" v={p.stopBeforeLiq ? <span className="text-up">是</span> : <span className="text-down">否</span>} />
        </div>
      )}
      {p && !p.stopBeforeLiq && <p className="text-sm text-down">这样加，强平价会跑到止损之前：价格还没到止损就会被强平。减少数量或降低杠杆。</p>}
      <p className="text-[11px] leading-relaxed text-ink-3">
        规则：只在赚钱的一边、价格收盘越过关键位后加；先把止损移到新的保护位，再按“加完整笔打到止损最多亏{acc.budget === "even" ? " 0（保本）" : `每笔风险 ${acc.riskPct}%`}”算数量。数量可以自己改，结果照样算给你看。
      </p>
      <button disabled={!(q > 0 && at > 0)} className="rounded-lg bg-ink px-3 py-1.5 text-sm text-bg disabled:opacity-40" onClick={() => (onRecord({ kind: "add", price: at, qty: q }, lev), setQty(0))}>
        我按这个加了
      </button>
    </div>
  );
}

function ReducePanel({ v, acc, onRecord }: { v: View; acc: Account; onRecord: (f: Fill) => void }) {
  const [atIn, setAt] = useState(0);
  const [qtyIn, setQty] = useState(0);
  const at = atIn > 0 ? atIn : +(v.cuts[0]?.price ?? v.price ?? 0).toPrecision(6);
  const qty = qtyIn > 0 ? qtyIn : +(v.pos.qty / 3).toPrecision(4);
  const r = at > 0 && qty > 0 ? previewReduce(v.pos, at, qty, acc.fee) : null;
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="text-[15px] font-semibold">减仓计算</h3>
      <div className="grid grid-cols-2 gap-2.5 text-xs text-ink-3">
        <Num id="cut-price" label="减仓价" value={at} onChange={setAt} />
        <Num id="cut-qty" label="减多少" value={qty} onChange={setQty} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[1 / 3, 1 / 2, 1].map((s) => (
          <button key={s} className="chip" onClick={() => setQty(+(v.pos.qty * s).toPrecision(6))}>{s === 1 ? "全平" : s === 0.5 ? "一半" : "三分之一"}</button>
        ))}
      </div>
      {r && (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Kpi k="这次落袋" v={<span className={toneColor(r.realized)}>{money(r.realized)}</span>} sub="已扣手续费" />
          <Kpi k="剩下" v={trimQty(r.left)} sub={`均价不变 ${fmtPrice(r.avg)}`} />
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-ink-3">减仓不改变均价（币安合约的规则），只把这一部分的盈亏落袋。默认在前方关键位各减三分之一，剩下的跟着移动认错位拿。</p>
      <button disabled={!r || !(r.qty > 0)} className="rounded-lg bg-ink px-3 py-1.5 text-sm text-bg disabled:opacity-40" onClick={() => r && onRecord({ kind: "reduce", price: at, qty: r.qty })}>
        我按这个减了
      </button>
    </div>
  );
}

function Settings({ h, v, onChange }: { h: Holding; v: View; onChange: (p: Partial<Holding>) => void }) {
  const [targets, setTargets] = useState(h.targets.join(", "));
  return (
    <div className="grid grid-cols-2 gap-2.5 text-xs text-ink-3 sm:grid-cols-4">
      <label className="space-y-1">
        <span>保证金模式</span>
        <select id="h-mode" className={field} value={h.mode} onChange={(e) => onChange({ mode: e.target.value as MarginMode })}>
          <option value="isolated">逐仓</option>
          <option value="cross">全仓</option>
        </select>
      </label>
      <Num id="h-lev" label="杠杆倍数" value={h.leverage} onChange={(x) => onChange({ leverage: Math.max(1, x) })} />
      <div className="space-y-1">
        <Num id="h-stop" label="止损（空着用计划页的）" value={h.stop ?? 0} onChange={(x) => onChange({ stop: x > 0 ? x : null })} />
        {v.st && (
          <button className="text-accent" onClick={() => onChange({ stop: +v.st!.stop.toPrecision(6) })}>
            用结构认错位 {fmtPrice(v.st.stop)}
          </button>
        )}
      </div>
      <label className="space-y-1">
        <span>我的价位（逗号分隔）</span>
        <input
          id="h-targets"
          className={field}
          value={targets}
          placeholder="2350, 2400"
          onChange={(e) => setTargets(e.target.value)}
          onBlur={() => onChange({ targets: targets.split(/[,，\s]+/).map(Number).filter((x) => x > 0) })}
        />
      </label>
    </div>
  );
}

function Fills({ h, acc, onChange }: { h: Holding; acc: Account; onChange: (p: Partial<Holding>) => void }) {
  const pos = positionOf(h.dir, h.fills, acc.fee);
  const [avg, setAvg] = useState(+pos.avg.toPrecision(6));
  const [qty, setQty] = useState(+pos.qty.toPrecision(6));
  const name = { open: "开仓", add: "加仓", reduce: "减仓" } as const;
  return (
    <div className="mt-2 space-y-3">
      <table className="num w-full text-sm">
        <tbody>
          {h.fills.map((f, i) => (
            <tr key={i} className="border-b border-line">
              <td className="py-1">{name[f.kind]}</td>
              <td className="py-1 text-right">{fmtPrice(f.price)}</td>
              <td className="py-1 text-right">{trimQty(f.qty)}</td>
              <td className="py-1 text-right">
                {h.fills.length > 1 && <button className="text-xs text-ink-3" onClick={() => onChange({ fills: h.fills.filter((_, j) => j !== i) })}>删掉</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-2 rounded-lg border border-line p-3 text-xs text-ink-3">
        <p>和交易所对不上（部分成交、返佣、资金费）时，直接填交易所显示的均价和数量，已实现盈亏保留。</p>
        <div className="grid grid-cols-2 gap-2.5 sm:w-1/2">
          <Num id="fix-avg" label="交易所均价" value={avg} onChange={setAvg} />
          <Num id="fix-qty" label="交易所数量" value={qty} onChange={setQty} />
        </div>
        <button disabled={!(avg > 0 && qty > 0)} className="rounded-lg border border-line px-3 py-1.5 text-ink disabled:opacity-40" onClick={() => onChange({ fills: [{ kind: "open", price: avg, qty }], realizedBase: h.realizedBase + pos.realized })}>
          改成交易所的数字
        </button>
      </div>
    </div>
  );
}

function Num({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="space-y-1">
      <span>{label}</span>
      <input id={id} type="number" inputMode="decimal" className={field} value={value || ""} onChange={(e) => onChange(+e.target.value)} />
    </label>
  );
}

function HoldingForm({ coins, price, onAdd, onCancel }: { coins: string[]; price: (c: string) => number | null; onAdd: (h: Holding) => void; onCancel: () => void }) {
  const [coin, setCoin] = useState(coins[0] ?? "BTC");
  const [dir, setDir] = useState<Dir>(1);
  const [mode, setMode] = useState<MarginMode>("isolated");
  const [lev, setLev] = useState(10);
  const [entry, setEntry] = useState(0);
  const [by, setBy] = useState<"qty" | "margin">("margin");
  const [amount, setAmount] = useState(0);
  const [stop, setStop] = useState(0);
  const qty = by === "qty" ? amount : entry > 0 ? (amount * lev) / entry : 0;
  const stopOk = !(stop > 0) || dir * (entry - stop) > 0;
  const ok = entry > 0 && qty > 0 && lev >= 1 && stopOk;
  const live = price(coin);
  return (
    <section className="card space-y-3 p-4 text-xs text-ink-3">
      <h2 className="text-[15px] font-semibold text-ink">添加持仓</h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <label className="space-y-1">
          <span>币种</span>
          <select id="new-coin" className={field} value={coin} onChange={(e) => setCoin(e.target.value)}>
            {coins.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span>方向</span>
          <select id="new-dir" className={field} value={dir} onChange={(e) => setDir(+e.target.value as Dir)}>
            <option value={1}>做多</option>
            <option value={-1}>做空</option>
          </select>
        </label>
        <label className="space-y-1">
          <span>保证金模式</span>
          <select id="new-mode" className={field} value={mode} onChange={(e) => setMode(e.target.value as MarginMode)}>
            <option value="isolated">逐仓</option>
            <option value="cross">全仓</option>
          </select>
        </label>
        <Num id="new-lev" label="杠杆倍数" value={lev} onChange={setLev} />
        <div className="space-y-1">
          <Num id="new-entry" label="开仓价" value={entry} onChange={setEntry} />
          {live != null && <button className="text-accent" onClick={() => setEntry(+live.toPrecision(6))}>用现价 {fmtPrice(live)}</button>}
        </div>
        <div className="space-y-1">
          <Num id="new-amount" label={by === "margin" ? "保证金 (USDT)" : `数量 (${coin})`} value={amount} onChange={setAmount} />
          <button className="text-accent" onClick={() => (setBy(by === "margin" ? "qty" : "margin"), setAmount(0))}>改填{by === "margin" ? "数量" : "保证金"}</button>
        </div>
        <Num id="new-stop" label="止损（可不填）" value={stop} onChange={setStop} />
        <div className="space-y-1">
          <span>换算</span>
          <div className="num py-1.5 text-sm text-ink">{qty > 0 && entry > 0 ? `${trimQty(qty)} ${coin} · 仓位价值 ${Math.round(qty * entry).toLocaleString("en-US")}` : "—"}</div>
        </div>
      </div>
      {!stopOk && <p className="text-down">{dir > 0 ? "做多的止损要低于开仓价。" : "做空的止损要高于开仓价。"}</p>}
      <div className="flex gap-2">
        <button
          disabled={!ok}
          className="rounded-lg bg-ink px-3 py-1.5 text-sm text-bg disabled:opacity-40"
          onClick={() => onAdd({ id: uid(), coin, dir, mode, leverage: lev, fills: [{ kind: "open", price: entry, qty, t: Math.floor(Date.now() / 1000) }], stop: stop > 0 ? stop : null, targets: [], realizedBase: 0 })}
        >
          添加
        </button>
        <button className="rounded-lg border border-line px-3 py-1.5 text-sm" onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}

function Rules() {
  return (
    <details className="card p-4 text-sm leading-relaxed">
      <summary className="cursor-pointer font-semibold">这页按什么规则算</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
        <li>只在赚钱的一边加仓，亏损的单不加仓摊平（马丁格尔会把一笔错单放大）。</li>
        <li>加仓等价格<b>收盘</b>越过前方关键位（来自趋势与计划页的 4 小时关键位），先把止损移到新的保护位，再算能加多少。</li>
        <li>每次加完，整笔打到止损最多亏“每笔风险”（或选“保本滚仓”：不亏）；每次不超过上一笔的 {ROLL_RULES.pyramid * 100}%，最多加 {ROLL_RULES.maxAdds} 次；止损要在强平前至少 {ROLL_RULES.liqGapAtr} 倍 ATR；实际杠杆不超过 {ROLL_RULES.maxLeverage} 倍。</li>
        <li>减仓：前方第一个、第二个关键位各减三分之一，剩下跟着移动认错位。离强平不到 {ROLL_RULES.nearLiqAtr} 倍 ATR 时先减仓或补保证金。</li>
        <li>
          回测（E31，10 个币的 4 小时 K 线，2020 年起 2,027 笔，入场和计划页同一套）：按这套规则滚仓比不滚平均每笔只多 0.05R，没到 0.1R 的门槛，换预算、金字塔比例、加仓次数或改用日线也一样；在“收盘越过摆动点”时加，和持仓期间随便挑时间加差不多。加过仓的交易里约七成比不滚更差（平均少 0.29R），三成更好（平均多 1.09R），多出来的全靠少数大行情；连续亏损时的最大回撤大了约三成。风险预算是守住了的：打到止损亏超过 1.1 倍初始风险的只有 0.5%。所以滚仓不会让你更常赚，只是在大行情里拿得更重。
        </li>
      </ul>
    </details>
  );
}
