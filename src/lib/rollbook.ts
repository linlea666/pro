/**
 * 滚仓助手的账户本：账户 → 持仓 → 成交记录，以及一笔持仓在当前行情下的全部数字（页面和邮件提醒共用），
 * 和提醒的判断（纯函数，服务器每分钟跑一次）。规则见 ta/roll.ts。
 */

import { stopOf, type ExSnapshot } from "./exchange.ts";
import type { TrendPlan } from "./trendplan.ts";
import { cutPlan, DEFAULT_FEE, ROLL_RULES, planSteps, fundingCost, liquidationPrice, maxAdd, nextAddLevel, pnlAt, positionOf, rollStatus, trimQty, type CutMode, type Dir, type Fill, type MarginMode } from "./ta/roll.ts";

export interface Holding {
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
  /** the close that confirms an add beyond a key level (default 4h; E31b: 1h / 15m no different) */
  confirmTf?: ConfirmTf;
  /** mail when the floating profit gives back half (E31c: smoother, not more) */
  giveback?: boolean;
  /** "bold": break-even rolling, each add up to the previous fill, up to 5 adds; "aggressive": the same with
   *  the per-trade risk as the budget (E31d) */
  style?: "bold" | "aggressive";
  /** isolated only: adds not capped by the account's real leverage (the stop-before-liquidation rule stays) */
  noLevCap?: boolean;
  /** E31f: after a 4-hour close beyond the first key level past the break-even price, move the stop to break-even */
  breakeven?: boolean;
  /** cuts at the levels ahead: absent = "close" (E31e) */
  cutMode?: "touch" | "none";
  /** E31g (Livermore / Tony): the first fill is a probe of a third; adds as big as the probe, two of them */
  probe?: boolean;
  /** E31g (Tony): each add carries its own stop beyond the level it broke; a hit closes only that add */
  addStops?: boolean;
  example?: boolean;
  /** synced from a read-only exchange account: quantity, average, mode and leverage follow the exchange */
  source?: "exchange";
  ex?: HoldingEx;
}

/** What the exchange says about a synced holding, refreshed every sync. */
export interface HoldingEx {
  /** ExPosition.key */
  key: string;
  instId: string;
  /** the exchange's liquidation price */
  liq: number | null;
  mark: number;
  upl: number;
  margin: number | null;
  mmr: number | null;
  /** the tightest stop-loss order on the exchange, and how much of the position stop orders cover */
  sl: number | null;
  covered: number | null;
  tp: number | null;
  trail: boolean;
  /** ms */
  t: number;
}

export type ConfirmTf = "4h" | "1h" | "15m";
export const CONFIRM_TFS: ConfirmTf[] = ["4h", "1h", "15m"];
export const CONFIRM_NAME: Record<ConfirmTf, string> = { "4h": "4 小时", "1h": "1 小时", "15m": "15 分钟" };
/** E31c: the best price at least `atr` ATR beyond the average, then a price that keeps ≤ `keep` of that profit → cut `cut` */
/** E31d: the user's "stop at the entry, roll with the profit" — break-even budget, adds as big as the last fill, 5 adds */
export const BOLD_RULES = { pyramid: 1, maxAdds: 5 };
/** E31g: probe a third, then two adds as big as the probe (the full size after both) */
export const PROBE_RULES = { pyramid: 1, maxAdds: 2, share: 1 / 3 };
export const rulesOf = (h: Pick<Holding, "style" | "noLevCap" | "mode" | "probe">) => {
  const r: { pyramid?: number; maxAdds?: number; maxLeverage?: number } = h.probe
    ? { pyramid: PROBE_RULES.pyramid, maxAdds: PROBE_RULES.maxAdds }
    : h.style === "bold" || h.style === "aggressive" ? { ...BOLD_RULES } : {};
  if (h.noLevCap && h.mode === "isolated") r.maxLeverage = Infinity;
  return Object.keys(r).length ? r : undefined;
};
export const CUT_MODES: CutMode[] = ["close", "touch", "none"];
export const CUT_NAME: Record<CutMode, string> = { close: "4 小时收盘没站稳才减", touch: "碰到关键位就减", none: "不减，只跟移动止损" };
export const cutModeOf = (h: Pick<Holding, "cutMode">): CutMode => (h.cutMode === "touch" || h.cutMode === "none" ? h.cutMode : "close");
/**
 * E31f: the break-even stop (the average plus a round trip of taker fees, so a hit loses nothing) and the
 * first key level beyond it; `met` once the last closed 4-hour bar closed beyond that level, `done` once the
 * stop is at or beyond break-even.
 */
export function breakevenOf(dir: Dir, avg: number, fee: number, levels: number[], lastClose: number | null, stop: number | null) {
  const price = avg * (1 + dir * 2 * fee);
  const level = levels.filter((x) => dir * (x - price) > 0).sort((a, b) => dir * (a - b))[0] ?? null;
  // a level already behind the last close counts as stood: the nearest one between break-even and that close
  const stood = lastClose != null ? levels.filter((x) => dir * (x - price) > 0 && dir * (lastClose - x) > 0).sort((a, b) => dir * (b - a))[0] ?? null : null;
  return { price, level: stood ?? level, met: stood != null, done: stop != null && dir * (stop - price) >= 0 };
}
export const GIVEBACK = { atr: 2, keep: 0.5, cut: 1 / 3 };
/** E31g: the key level an add at `at` broke: the nearest one past `from` (the last open fill) up to `at` */
export function crossedLevel(dir: Dir, levels: number[], from: number, at: number): number | null {
  return levels.filter((x) => dir * (x - from) > 0 && dir * (at - x) >= 0).sort((a, b) => dir * (b - a))[0] ?? null;
}
/**
 * E31g: an add's own stop, the broken level less the p80 sweep buffer; null when there is no level,
 * no ATR, or the common stop is already as tight (then the add simply shares it).
 */
export function addStopOf(dir: Dir, level: number | null, atr: number | null, buf: number | null | undefined, stop: number | null, at: number): number | null {
  if (level == null || !(atr != null && atr > 0)) return null;
  const own = level - dir * (buf ?? 0.5) * atr;
  if (dir * (at - own) <= 0) return null;
  if (stop != null && dir * (stop - own) >= 0) return null;
  return own;
}
const confirmOf = (h: Holding): ConfirmTf => (h.confirmTf && CONFIRM_TFS.includes(h.confirmTf) ? h.confirmTf : "4h");

export interface Account {
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
  /** the exchange account it mirrors: the total follows the exchange equity, synced holdings follow its positions */
  exchange?: string;
}

export interface RollAlertConfig {
  enabled: boolean;
  /** recipients; empty: the system-alert recipients */
  to: string[];
  dailyCap: number;
}

export interface RollBook {
  accounts: Account[];
  alert: RollAlertConfig;
}

export const DEFAULT_ROLL_ALERT: RollAlertConfig = { enabled: false, to: [], dailyCap: 30 };
/** all positions at their stops at once: warn beyond this share of the account */
export const ACCOUNT_RISK_PCT = 6;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : d);
const str = (x: unknown, max: number, d = "") => (typeof x === "string" ? x.slice(0, max) : d);
const posNum = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
const cleanEx = (e: HoldingEx): HoldingEx => ({
  key: str(e.key, 60),
  instId: str(e.instId, 40),
  liq: posNum(e.liq),
  mark: num(e.mark, 0, 1e12, 0),
  upl: num(e.upl, -1e12, 1e12, 0),
  margin: posNum(e.margin),
  mmr: posNum(e.mmr),
  sl: posNum(e.sl),
  covered: posNum(e.covered),
  tp: posNum(e.tp),
  trail: e.trail === true,
  t: num(e.t, 0, 1e15, 0),
});

/**
 * Mirror exchange snapshots into the book. Each snapshot gets one account (created the first time,
 * `exchange` = the snapshot id) whose total is the exchange equity. Its synced holdings follow the
 * open positions on the site's coins: new ones are added with one opening fill at the exchange average,
 * closed ones are dropped, and a changed quantity or average replaces the fills. Everything set on the
 * page (stop, targets, style, cut mode …) is kept. Hand-entered holdings are left alone. Accounts whose
 * snapshot failed this round are not touched.
 */
export function reconcileBook(book: RollBook, snaps: ExSnapshot[]): RollBook {
  const accounts = book.accounts.map((a) => ({ ...a }));
  for (const s of snaps) {
    let acc = accounts.find((a) => a.exchange === s.id);
    if (!acc) {
      acc = { id: `ex-${s.id}`.slice(0, 20), name: s.name, total: 0, riskPct: 2, budget: "keep", fee: DEFAULT_FEE.taker, holdings: [], exchange: s.id };
      accounts.push(acc);
    }
    acc.total = Math.round(s.equity * 100) / 100;
    const old = new Map(acc.holdings.filter((h) => h.source === "exchange" && h.ex).map((h) => [h.ex!.key, h]));
    const synced: Holding[] = [];
    for (const p of s.positions) {
      if (!p.coin || !(p.qty > 0) || !(p.avg > 0)) continue;
      const was = old.get(p.key);
      const cur = was ? positionOf(was.dir, was.fills, acc.fee) : null;
      const same = cur != null && Math.abs(cur.qty - p.qty) <= p.qty * 1e-9 && Math.abs(cur.avg - p.avg) <= p.avg * 1e-9;
      const st = stopOf(s, p);
      const ex: HoldingEx = { key: p.key, instId: p.instId, liq: p.liq, mark: p.mark, upl: p.upl, margin: p.margin, mmr: p.mmr, sl: st.sl, covered: st.covered, tp: st.tp, trail: st.trail, t: s.t };
      // the exchange's realized profit already includes the opening fee that one opening fill books again
      const realizedBase = same ? was!.realizedBase : (p.realized ?? 0) + p.qty * p.avg * acc.fee;
      synced.push({
        ...(was ?? { id: `x${Math.random().toString(36).slice(2, 10)}`, stop: null, targets: [] }),
        coin: p.coin,
        dir: p.dir,
        mode: p.mode,
        leverage: p.lever,
        fills: same ? was!.fills : [{ kind: "open", price: p.avg, qty: p.qty, ...(p.t ? { t: p.t } : {}) }],
        realizedBase,
        source: "exchange",
        ex,
      });
    }
    acc.holdings = [...acc.holdings.filter((h) => h.source !== "exchange"), ...synced];
  }
  return { ...book, accounts };
}

/** Clean a book sent by the browser: drops what is malformed, caps sizes. Throws on bad recipients. */
export function cleanBook(input: unknown, coins: string[]): RollBook {
  const b = (input ?? {}) as Partial<RollBook>;
  const accounts = (Array.isArray(b.accounts) ? b.accounts : []).slice(0, 20).map((a): Account => ({
    id: str(a?.id, 20) || Math.random().toString(36).slice(2, 10),
    name: str(a?.name, 40, "账户"),
    total: num(a?.total, 0, 1e12, 0),
    riskPct: num(a?.riskPct, 0.1, 10, 2),
    budget: a?.budget === "even" ? "even" : "keep",
    fee: num(a?.fee, 0, 0.01, DEFAULT_FEE.taker),
    holdings: (Array.isArray(a?.holdings) ? a.holdings : [])
      .filter((h) => h && coins.includes(h.coin) && !h.example)
      .slice(0, 30)
      .map((h): Holding => ({
        id: str(h.id, 20) || Math.random().toString(36).slice(2, 10),
        coin: h.coin,
        dir: h.dir === -1 ? -1 : 1,
        mode: h.mode === "cross" ? "cross" : "isolated",
        leverage: num(h.leverage, 1, 200, 1),
        fills: (Array.isArray(h.fills) ? h.fills : [])
          .filter((f) => f && ["open", "add", "reduce"].includes(f.kind) && f.price > 0 && f.qty > 0)
          .slice(0, 200)
          .map((f) => ({ kind: f.kind, price: +f.price, qty: +f.qty, ...(f.t ? { t: Math.floor(+f.t) } : {}), ...(f.kind === "add" && typeof f.stop === "number" && f.stop > 0 ? { stop: +f.stop } : {}), ...(f.kind === "add" && f.closed === true ? { closed: true } : {}) })),
        stop: typeof h.stop === "number" && h.stop > 0 ? h.stop : null,
        targets: (Array.isArray(h.targets) ? h.targets : []).filter((x) => typeof x === "number" && x > 0).slice(0, 10),
        realizedBase: num(h.realizedBase, -1e12, 1e12, 0),
        ...(h.giveback === true ? { giveback: true } : {}),
        ...(h.breakeven === true ? { breakeven: true } : {}),
        ...(h.probe === true ? { probe: true } : {}),
        ...(h.addStops === true ? { addStops: true } : {}),
        ...(h.style === "bold" || h.style === "aggressive" ? { style: h.style } : {}),
        ...(h.noLevCap === true ? { noLevCap: true } : {}),
        ...(h.cutMode === "touch" || h.cutMode === "none" ? { cutMode: h.cutMode } : {}),
        ...(h.confirmTf && CONFIRM_TFS.includes(h.confirmTf) && h.confirmTf !== "4h" ? { confirmTf: h.confirmTf } : {}),
        ...(h.source === "exchange" && h.ex && typeof h.ex.key === "string" ? { source: "exchange" as const, ex: cleanEx(h.ex) } : {}),
      }))
      .filter((h) => h.fills.length),
    ...(typeof a?.exchange === "string" && a.exchange ? { exchange: a.exchange.slice(0, 20) } : {}),
  }));
  const al = (b.alert ?? {}) as Partial<RollAlertConfig>;
  const to = (Array.isArray(al.to) ? al.to : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
  const bad = to.find((x) => !EMAIL.test(x));
  if (bad) throw new Error(`收件邮箱格式不正确：${bad}`);
  return { accounts, alert: { enabled: !!al.enabled, to, dailyCap: Math.floor(num(al.dailyCap, 1, 200, DEFAULT_ROLL_ALERT.dailyCap)) } };
}

export interface LevelInfo {
  price: number;
  methods: string[];
  methodCount: number;
  tfs: string[];
  strength: number;
}

/** "前日/周/月高低、Fib Pivot 等 5 种方法 · 周线 / 日线 / 1小时": what a level is made of. */
export function levelSource(info: LevelInfo[] | undefined, price: number): string | null {
  const l = info?.find((x) => Math.abs(x.price - price) <= price * 1e-9);
  if (!l || !l.methods.length) return null;
  const m = l.methods.join("、") + (l.methodCount > l.methods.length ? ` 等 ${l.methodCount} 种方法` : l.methods.length > 1 ? ` ${l.methods.length} 种方法` : "");
  return l.tfs.length ? `${m} · ${l.tfs.join(" / ")}` : m;
}

/** What the page and the alerts need of one coin's market. */
export interface Market {
  price: number | null;
  /** entry-timeframe (4-hour) ATR */
  atr: number | null;
  /** key levels of the 4-hour plan */
  levels: number[];
  /** where each key level comes from (the key-level card's methods and timeframes) */
  levelInfo?: LevelInfo[];
  /** the coin's p80 sweep buffer, ATR (E31g's add stops) */
  buf?: number;
  /** the plan's structure stop for a long (1) and a short (−1) */
  swingStop: Record<"1" | "-1", { stop: number; anchor: number } | null>;
  funding: number | null;
  /** the last two closed 4-hour closes, and the last one's high and low */
  lastClose: { t: number; c: number; prev: number; hi?: number; lo?: number } | null;
  /** the last two closed 1-hour / 15-minute closes, when a holding confirms adds on them */
  closes?: Partial<Record<"1h" | "15m", { t: number; c: number; prev: number }>>;
}

/**
 * The structure stop of the 4-hour plan: the last swing low (high for shorts), or a lower low
 * made since, plus the p80 sweep buffer. Same as the plan page's `structureStop`.
 */
export function marketOf(p: TrendPlan | null, price: number | null, funding: number | null): Market {
  if (!p) return { price, atr: null, levels: [], swingStop: { "1": null, "-1": null }, funding, lastClose: null };
  const closed = p.forming ? p.candles.slice(0, -1) : p.candles;
  const view = p.map.find((m) => m.role === "entry")?.view;
  const stopOf = (dir: Dir) => {
    const sw = dir > 0 ? view?.lastLow : view?.lastHigh;
    if (!sw || !(p.atr > 0)) return null;
    let anchor = sw.price;
    for (const c of closed) if (c.t >= sw.t) anchor = dir > 0 ? Math.min(anchor, c.l) : Math.max(anchor, c.h);
    return { anchor, stop: anchor - dir * p.buffers.p80 * p.atr };
  };
  const n = closed.length;
  return {
    price: price ?? p.price,
    atr: p.atr,
    levels: p.levels.map((x) => x.price),
    levelInfo: p.levels.map((x) => ({ price: x.price, methods: x.methods, methodCount: x.methodCount ?? x.methods.length, tfs: x.tfs ?? [], strength: x.strength })),
    buf: p.buffers.p80,
    swingStop: { "1": stopOf(1), "-1": stopOf(-1) },
    funding,
    lastClose: n >= 2 ? { t: closed[n - 1].t, c: closed[n - 1].c, prev: closed[n - 2].c, hi: closed[n - 1].h, lo: closed[n - 1].l } : null,
  };
}

/**
 * The stop orders on the exchange for a synced holding: none at all, one that sits beyond the
 * liquidation price (liquidated first, the stop never fills), or orders covering only part of it.
 */
export function exGuard(h: Pick<Holding, "dir" | "ex">, qty: number): { state: "ok" | "none" | "beyondLiq" | "partial"; title: string; detail: string } | null {
  const e = h.ex;
  if (!e || !(qty > 0)) return null;
  if (e.sl == null)
    return { state: "none", title: "交易所没有止损单", detail: "这笔仓位在交易所上没有挂止损（裸奔）。行情急跌时没有任何保护，请先在交易所挂好止损单，提醒不能代替止损单。" };
  if (e.liq != null && h.dir * (e.sl - e.liq) <= 0)
    return { state: "beyondLiq", title: "止损单在强平价后面", detail: `止损单 ${fp(e.sl)} 比强平价 ${fp(e.liq)} 还远，价格先到强平，止损单永远不会成交。把止损挪到强平价之前，或者减仓 / 补保证金让强平价远离。` };
  if (e.covered != null && e.covered < qty * 0.99)
    return { state: "partial", title: "止损单只覆盖一部分仓位", detail: `止损单合计 ${trimQty(e.covered)}，持仓 ${trimQty(qty)}，打到止损后还剩 ${trimQty(qty - e.covered)} 没有保护。` };
  return { state: "ok", title: "交易所止损单已挂好", detail: `止损 ${fp(e.sl)}${e.trail ? "（移动止损）" : ""}，覆盖全部仓位。` };
}

/** Everything about one holding at the current market. */
export function holdingView(h: Holding, acc: Account, m: Market) {
  const pos = positionOf(h.dir, h.fills, acc.fee);
  pos.realized += h.realizedBase;
  const { price, atr } = m;
  const st = m.swingStop[String(h.dir) as "1" | "-1"];
  // a stop order on the exchange is what will actually fill; then the stop set here; then the structure stop
  const stop = h.ex?.sl ?? h.stop ?? st?.stop ?? null;
  const stopFrom: "exchange" | "page" | "structure" | null = h.ex?.sl != null ? "exchange" : h.stop != null ? "page" : st ? "structure" : null;
  // the exchange's own liquidation price when synced (it knows the tiers and the whole account)
  const liq = h.ex ? h.ex.liq : liquidationPrice({ dir: h.dir, qty: pos.qty, avg: pos.avg, mode: h.mode, leverage: h.leverage, account: acc.total });
  const guard = exGuard(h, pos.qty);
  const rules = rulesOf(h);
  // E31g: an add closed at its own stop frees its slot (up to 5 adds in all)
  const closedAdds = h.addStops ? h.fills.filter((f) => f.kind === "add" && f.closed).length : 0;
  const rulesUsed = closedAdds ? { ...rules, maxAdds: Math.min(5, (rules?.maxAdds ?? ROLL_RULES.maxAdds) + closedAdds) } : rules;
  const budget = h.style === "bold" || (acc.budget === "even" && h.style !== "aggressive") ? 0 : (acc.total * acc.riskPct) / 100;
  const add = (at: number, atStop = stop) => (atStop != null ? maxAdd({ pos, price: at, stop: atStop, budget, mode: h.mode, leverage: h.leverage, account: acc.total, atr, fee: acc.fee, rules: rulesUsed }) : null);
  // the next level is where to add after a close beyond it while adding is still allowed; otherwise it is the first cut
  const next = price != null ? nextAddLevel(h.dir, price, m.levels) : null;
  const canAdd = next != null && (add(next)?.qty ?? 0) > 0;
  const cutMode = cutModeOf(h);
  const cuts = price != null && cutMode !== "none" ? cutPlan(pos, price, canAdd ? m.levels.filter((x) => h.dir * (x - next!) > 0) : m.levels, acc.fee) : [];
  const addLevel = canAdd || (next != null && !cuts.some((c) => c.price === next)) ? next : null;
  const status = price != null ? rollStatus({ pos, price, stop, liq, atr, cuts, addLevel, fee: acc.fee, confirm: CONFIRM_NAME[confirmOf(h)], cutMode }) : null;
  const open = price != null ? pnlAt(pos, price, acc.fee) : null;
  const atStop = stop != null && pos.qty > 0 ? pnlAt(pos, stop, acc.fee) : null;
  const fundDay = m.funding != null && price != null ? fundingCost(h.dir, pos.qty * price, m.funding, 3) : null;
  const addAt = canAdd ? add(next!) : null;
  const steps = price != null ? planSteps({ pos, price, stop, add: addAt && next != null ? { price: next, qty: addAt.qty } : null, levels: m.levels, fee: acc.fee, cuts: cutMode !== "none" }) : [];
  const be = h.breakeven && pos.qty > 0 ? breakevenOf(h.dir, pos.avg, acc.fee, m.levels, m.lastClose?.c ?? null, stop) : null;
  // E31g: the adds still open with their own stops, and the stop a new add at `at` would get
  const lastOpen = h.fills.filter((f) => f.kind !== "reduce" && !f.closed).at(-1)?.price ?? pos.avg;
  const lots = h.addStops && pos.qty > 0
    ? h.fills.flatMap((f, i) => (f.kind === "add" && !f.closed ? [{ i, price: f.price, qty: f.qty, from: h.fills.slice(0, i).filter((x) => x.kind !== "reduce").at(-1)?.price ?? f.price, stop: f.stop ?? null, atStop: f.stop != null ? h.dir * (f.stop - f.price) * f.qty - acc.fee * (f.price + f.stop) * f.qty : null }] : []))
    : [];
  const ownStop = (at: number) => (h.addStops ? addStopOf(h.dir, crossedLevel(h.dir, m.levels, lastOpen, at), atr, m.buf, stop, at) : null);
  return { be, lots, ownStop, lastOpen, buf: m.buf ?? null, levelInfo: m.levelInfo ?? [], cutMode, pos, price, atr, st, stop, stopFrom, guard, liq, levels: m.levels, cuts, addLevel, budget, rules: { pyramid: rulesUsed?.pyramid ?? ROLL_RULES.pyramid, maxAdds: rulesUsed?.maxAdds ?? ROLL_RULES.maxAdds, liqGapAtr: ROLL_RULES.liqGapAtr as number, maxLeverage: rules?.maxLeverage ?? (ROLL_RULES.maxLeverage as number) }, add, status, open, atStop, fundDay, funding: m.funding, steps };
}
export type HoldingView = ReturnType<typeof holdingView>;

// ---------------------------------------------------------------- alerts

export interface RollAlert {
  key: string;
  kind: "add" | "cut" | "giveback" | "target" | "stop" | "liq" | "risk" | "guard";
  title: string;
  lines: string[];
}

/** what the previous round saw, per holding id (and per account for the account risk) */
export type RollMemory = Record<string, { price?: number; status?: string; barT?: number; bar4?: number; best?: number; fills?: number; gave?: number; guard?: string }>;

const fp = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 3) : v.toPrecision(4));
const usd = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v)).toLocaleString("en-US")} USDT`;
const URGENT = new Set(["快到止损", "已经过了止损", "离强平太近", "已经越过强平价"]);

/**
 * New alerts since the last round, and the memory for the next one. A holding seen for the first
 * time is only recorded. Price alerts fire when the price crosses a cut level or a target between
 * two rounds; an add fires once per closed 4-hour bar that closes beyond a key level outside the
 * last fill, when the rules allow an add; the urgent states fire when they start.
 */
export function pickRollAlerts(book: RollBook, markets: Record<string, Market>, mem: RollMemory): { alerts: RollAlert[]; mem: RollMemory } {
  const alerts: RollAlert[] = [];
  const next: RollMemory = {};
  for (const acc of book.accounts) {
    let loss = 0, known = 0;
    // a synced position that appears after the account was first seen is a new trade: check its stop order at once
    const seen = !!mem[`seen:${acc.id}`];
    next[`seen:${acc.id}`] = {};
    for (const h of acc.holdings) {
      const m = markets[h.coin];
      if (!m || m.price == null) {
        if (mem[h.id]) next[h.id] = mem[h.id];
        continue;
      }
      const v = holdingView(h, acc, m);
      if (!(v.pos.qty > 0)) continue;
      const price = m.price;
      const was = mem[h.id];
      const tf = confirmOf(h);
      const lc = tf === "4h" ? m.lastClose : (m.closes?.[tf] ?? null);
      // the best price since the fills last changed, for the giveback alert
      const nf = h.fills.length;
      const best = was?.fills === nf && was.best != null ? (h.dir > 0 ? Math.max(was.best, price) : Math.min(was.best, price)) : price;
      next[h.id] = { price, status: v.status?.title, barT: lc?.t ?? was?.barT, bar4: m.lastClose?.t ?? was?.bar4, best, fills: nf, ...(was?.fills === nf && was.gave != null ? { gave: was.gave } : {}), ...(v.guard ? { guard: v.guard.state } : {}) };
      if (v.atStop != null) (loss += Math.max(0, -v.atStop)), known++;
      const head = `${acc.name} · ${h.coin} ${h.dir > 0 ? "多单" : "空单"}`;
      const base = `现价 ${fp(price)}，均价 ${fp(v.pos.avg)}，数量 ${trimQty(v.pos.qty)}，浮动盈亏 ${usd(v.open ?? 0)}`;
      if (v.guard && v.guard.state !== "ok" && (was ? was.guard !== v.guard.state : seen && h.source === "exchange"))
        alerts.push({ key: `${h.id}:guard:${v.guard.state}:${Math.round(v.pos.qty * 1e6)}`, kind: "guard", title: `${head}：${v.guard.title}`, lines: [v.guard.detail, `交易所强平价 ${fp(v.liq)}。`, base] });
      if (!was) continue;
      const srcLine = (x: number) => { const t = levelSource(m.levelInfo, x); return t ? [`这个位来自：${t}。`] : []; };
      const crossed = (x: number) => was.price != null && was.price !== x && (was.price - x) * (price - x) <= 0;

      if (v.status && URGENT.has(v.status.title) && was.status !== v.status.title) {
        const kind = v.status.title.includes("强平") ? "liq" : "stop";
        alerts.push({ key: `${h.id}:${v.status.title}:${Math.round(price)}`, kind, title: `${head}：${v.status.title}`, lines: [v.status.detail, base] });
      }
      // the cut levels as they stood before this round's move (the ones just crossed are behind the price now)
      if (v.cutMode === "touch" && was.price != null)
        for (const c of cutPlan(v.pos, was.price, v.addLevel != null ? m.levels.filter((x) => h.dir * (x - v.addLevel!) > 0) : m.levels, acc.fee))
          if (crossed(c.price))
            alerts.push({ key: `${h.id}:cut:${c.price}`, kind: "cut", title: `${head}：到减仓位 ${fp(c.price)}`, lines: [`按计划减 ${trimQty(c.qty)}，这部分落袋约 ${usd(c.realized)}，剩下 ${trimQty(c.left)}，均价不变。`, ...srcLine(c.price), base] });
      // E31f: the first 4-hour close beyond a key level past break-even, while the stop is still short of it
      const b4be = m.lastClose;
      if (v.be && !v.be.done && b4be && was.bar4 != null && b4be.t > was.bar4 && v.be.met && v.be.level != null && h.dir * (b4be.prev - v.be.level) <= 0)
        alerts.push({
          key: `${h.id}:be:${b4be.t}`,
          kind: "stop",
          title: `${head}：4 小时收盘${h.dir > 0 ? "站上" : "跌破"} ${fp(v.be.level)}，可以把止损移到保本价 ${fp(v.be.price)}`,
          lines: [
            `保本价 = 均价 ${fp(v.pos.avg)} 加上来回手续费，打到也不亏。你的止损现在是 ${fp(v.stop)}，记得在交易所改单，改完在页面上把止损也改成 ${fp(v.be.price)}。`,
            "回测（E31f）：站稳第一个关键位后再保本，平均不更赚（每笔少 0.04–0.09R，不显著），最大回撤小约 27%；太早保本明显更差。",
            ...srcLine(v.be.level),
            base,
          ],
        });
      // E31e: a 4-hour bar that reached a level beyond the average decides at its close: back inside → cut 1/3, held → keep
      const b4 = m.lastClose;
      if (v.cutMode === "close" && b4 && b4.hi != null && b4.lo != null && was.bar4 != null && b4.t > was.bar4) {
        const ext = h.dir > 0 ? b4.hi : b4.lo;
        const L = m.levels.filter((x) => h.dir * (x - v.pos.avg) > 0 && h.dir * (b4.prev - x) < 0 && h.dir * (ext - x) >= 0).sort((a, b) => h.dir * (b - a))[0];
        const held = L != null && h.dir * (b4.c - L) > 0;
        // a held level that is also an add on the 4-hour close gets the add alert below instead
        if (L != null && !(held && tf === "4h" && v.stop != null && (v.add(b4.c)?.qty ?? 0) > 0)) {
          const q = v.pos.qty / 3;
          alerts.push(
            held
              ? { key: `${h.id}:held:${b4.t}`, kind: "cut", title: `${head}：4 小时收盘${h.dir > 0 ? "站上" : "跌破"} ${fp(L)}，站稳了`, lines: [`收盘 ${fp(b4.c)} 在 ${fp(L)} ${h.dir > 0 ? "上面" : "下面"}。按“收盘没站稳才减”，这里不减，拿着，止损跟着结构移。`, ...srcLine(L), base] }
              : { key: `${h.id}:reject:${b4.t}`, kind: "cut", title: `${head}：冲击 ${fp(L)} 没站稳，减三分之一`, lines: [`这根 4 小时最${h.dir > 0 ? "高" : "低"}到 ${fp(ext)}，收盘 ${fp(b4.c)} 又回到 ${fp(L)} ${h.dir > 0 ? "下面" : "上面"}。按“收盘没站稳才减”，减 ${trimQty(q)}（三分之一），这部分落袋约 ${usd(h.dir * (b4.c - v.pos.avg) * q)}，剩下跟着移动止损。`, ...srcLine(L), base] },
          );
        }
      }
      // E31g: an open add crossing its own stop → close only that add
      for (const l of v.lots)
        if (l.stop != null && crossed(l.stop))
          alerts.push({
            key: `${h.id}:addstop:${l.i}:${l.stop}`,
            kind: "stop",
            title: `${head}：${fp(l.price)} 那笔加仓打到自己的止损 ${fp(l.stop)}`,
            lines: [
              `按“加仓单单独止损”，只平这一笔 ${trimQty(l.qty)}（约${l.atStop != null ? usd(l.atStop) : "—"}），底仓和其他仓位照常拿，下次收盘重新站上关键位可以再加。平完在页面上点“这笔已平”。`,
              base,
            ],
          });
      for (const t of h.targets)
        if (crossed(t)) alerts.push({ key: `${h.id}:target:${t}`, kind: "target", title: `${head}：到了你填的价位 ${fp(t)}`, lines: [`在这里全部平掉约 ${usd(pnlAt(v.pos, t, acc.fee))}（已扣手续费）。`, base] });

      if (h.giveback && v.atr != null && v.atr > 0 && next[h.id].gave !== best) {
        const at = (x: number) => h.dir * (x - v.pos.avg) * v.pos.qty;
        if (h.dir * (best - v.pos.avg) >= GIVEBACK.atr * v.atr && at(price) <= GIVEBACK.keep * at(best)) {
          next[h.id].gave = best;
          const q = v.pos.qty * GIVEBACK.cut;
          alerts.push({
            key: `${h.id}:giveback:${best}`,
            kind: "giveback",
            title: `${head}：浮盈吐回了一半`,
            lines: [
              `最好到过 ${fp(best)}（浮盈约 ${usd(at(best))}），现在只剩 ${usd(at(price))}。按你开的“浮盈回吐提醒”，可以先减 ${trimQty(q)}（三分之一）锁住一部分，这部分落袋约 ${usd(h.dir * (price - v.pos.avg) * q)}。`,
              "回测（E31c）里这样做平均少赚一点（每笔 0.03–0.08R），但最大回撤小了两到三成；它让结果更平稳，不是更赚。",
              base,
            ],
          });
        }
      }
      if (lc && was.barT != null && lc.t > was.barT && v.stop != null) {
        const last = v.lastOpen;
        const lvl = m.levels.filter((L) => h.dir * (L - last) > 0 && h.dir * (lc.prev - L) <= 0 && h.dir * (lc.c - L) > 0).sort((a, b) => h.dir * (b - a))[0];
        const lim = lvl != null ? v.add(lc.c) : null;
        if (lvl != null && lim && lim.qty > 0)
          alerts.push({
            key: `${h.id}:add:${lc.t}`,
            kind: "add",
            title: `${head}：${CONFIRM_NAME[tf]}收盘${h.dir > 0 ? "站上" : "跌破"} ${fp(lvl)}，可以加仓`,
            lines: [
              `按规则最多加 ${trimQty(lim.qty)}（约 ${fp(lc.c)}），加完均价 ${fp(lim.avg)}，强平 ${fp(lim.liq)}，打到止损 ${fp(v.stop)} ${lim.atStop >= 0 ? "也赚" : "亏"} ${Math.abs(Math.round(lim.atStop)).toLocaleString("en-US")} USDT。`,
              ...(h.addStops ? (() => { const o = addStopOf(h.dir, lvl, v.atr, m.buf, v.stop, lc.c); return [o != null ? `这笔加仓单独止损：${fp(o)}（${fp(lvl)} 外加扫损缓冲），打到只平这一笔。` : `这笔加仓和底仓共用止损 ${fp(v.stop)}（已经比单独止损更紧）。`]; })() : []),
              "先确认止损已经移到新的保护位；规则只给上限，不是一定要加。回测（E31）里滚仓没有可证明比不滚多赚。",
              base,
            ],
          });
      }
    }
    if (acc.total > 0 && known) {
      const pct = (loss / acc.total) * 100;
      const st = pct > ACCOUNT_RISK_PCT ? "over" : "ok";
      const k = `acct:${acc.id}`;
      next[k] = { status: st };
      if (mem[k] && mem[k].status !== "over" && st === "over")
        alerts.push({ key: `${k}:over:${Math.round(pct)}`, kind: "risk", title: `${acc.name}：账户总风险超过 ${ACCOUNT_RISK_PCT}%`, lines: [`所有持仓一起打到止损要亏 ${Math.round(loss).toLocaleString("en-US")} USDT，是账户的 ${pct.toFixed(1)}%。考虑减仓。`] });
    }
  }
  return { alerts, mem: next };
}

/** One mail for one round. */
export function rollMailText(alerts: RollAlert[], siteUrl = "", capNote = ""): { subject: string; text: string } {
  const subject = alerts.length === 1 ? `滚仓提醒：${alerts[0].title}` : `滚仓提醒：${alerts.length} 条（${alerts[0].title} 等）`;
  const body = alerts.map((a) => [`■ ${a.title}`, ...a.lines.map((l) => `  ${l}`)].join("\n"));
  const tail = ["", "价格和强平是估算，以交易所为准；止损请在交易所挂好，提醒不能代替止损单。", ...(siteUrl ? [`页面：${siteUrl}/roll`] : []), ...(capNote ? ["", capNote] : [])];
  return { subject, text: [...body, ...tail].join("\n\n").replace(/\n\n\n+/g, "\n\n") };
}
