import { getDb } from "./db.ts";
import { setState } from "./settings.ts";
import { BUILTIN_COINS, COIN_ID_RE, RESEARCH_COINS, type CoinMeta } from "../symbols.ts";

/**
 * The coins shown on the site, kept in the `coins` table so an admin can add or hide
 * one without a release. The table starts as BUILTIN_COINS. Hiding keeps the stored
 * candles, so a coin shown again needs no second backfill. Research reports keep using
 * the fixed RESEARCH_COINS whatever is shown.
 */

/** each shown coin costs a precompute pass, a scorecard queue and its own long history on a 2-core server */
export const MAX_ACTIVE_COINS = 15;

export interface CoinRow extends CoinMeta {
  enabled: boolean;
  sort: number;
  addedAt: number;
  /** first daily bar on the exchange (seconds), when known */
  listedAt: number | null;
  /** one of the coins the research reports are computed on */
  research: boolean;
  builtin: boolean;
}

type Raw = { id: string; name: string; intro: string; enabled: number; sort: number; added_at: number; listed_at: number | null };

const TTL_MS = 5_000;
let memo: { at: number; rows: CoinRow[] } | null = null;

function toRow(r: Raw): CoinRow {
  return {
    id: r.id,
    name: r.name,
    intro: r.intro,
    enabled: r.enabled === 1,
    sort: r.sort,
    addedAt: r.added_at,
    listedAt: r.listed_at,
    research: RESEARCH_COINS.includes(r.id),
    builtin: BUILTIN_COINS.some((c) => c.id === r.id),
  };
}

const builtinRows = (): CoinRow[] =>
  BUILTIN_COINS.map((c, i) => ({ ...c, enabled: true, sort: i, addedAt: 0, listedAt: null, research: true, builtin: true }));

/** Every coin, hidden ones included, in display order. */
export function allCoins(): CoinRow[] {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.rows;
  let rows: CoinRow[];
  try {
    const d = getDb();
    if (!(d.prepare("SELECT COUNT(*) n FROM coins").get() as { n: number }).n) {
      const ins = d.prepare("INSERT OR IGNORE INTO coins (id, name, intro, enabled, sort, added_at) VALUES (?, ?, ?, 1, ?, ?)");
      d.transaction(() => BUILTIN_COINS.forEach((c, i) => ins.run(c.id, c.name, c.intro, i, Date.now())))();
    }
    rows = (d.prepare("SELECT * FROM coins ORDER BY sort, added_at").all() as Raw[]).map(toRow);
  } catch {
    // no database (some unit tests, scripts): the built-in list
    rows = builtinRows();
  }
  memo = { at: Date.now(), rows };
  return rows;
}

/** The coins shown on the site. */
export const activeCoins = (): CoinRow[] => allCoins().filter((c) => c.enabled);

/** Ids of the coins shown on the site: what the background jobs and pages loop over. */
export const coinIds = (): string[] => activeCoins().map((c) => c.id);

/** A shown coin by id (case-insensitive); hidden and unknown coins are undefined. */
export function findCoin(id: string): CoinRow | undefined {
  const up = id.toUpperCase();
  return activeCoins().find((c) => c.id === up);
}

/** The public fields, for pages. */
export const publicCoins = (): CoinMeta[] => activeCoins().map(({ id, name, intro }) => ({ id, name, intro }));

export interface ContractCheck {
  ok: boolean;
  /** first daily bar on Binance futures (seconds) */
  listedAt: number | null;
  message: string;
}

async function fetchJson(url: string, timeoutMs = 8_000): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { accept: "application/json" } });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is there a USDT perpetual on Binance futures still trading? Binance futures is the
 * primary source: the long history, funding, open interest and its archive all come
 * from it, so a coin only listed elsewhere is not accepted. The first daily bar gives
 * the listing date; the newest must be recent.
 */
export async function checkContract(id: string, nowSec = Date.now() / 1000): Promise<ContractCheck> {
  const base = `https://fapi.binance.com/fapi/v1/klines?symbol=${id}USDT&interval=1d&limit=1`;
  let first, last;
  try {
    [first, last] = await Promise.all([fetchJson(`${base}&startTime=0`), fetchJson(base)]);
  } catch (e) {
    return { ok: false, listedAt: null, message: `连不上 Binance 永续（${(e as Error).name === "AbortError" ? "超时" : (e as Error).message}），稍后再试` };
  }
  if (first.status === 400) return { ok: false, listedAt: null, message: `Binance 永续没有 ${id}USDT（有的币要加 1000 前缀，比如 1000PEPE）` };
  if (first.status !== 200 || !Array.isArray(first.body) || !first.body.length || !Array.isArray(last.body) || !last.body.length) {
    return { ok: false, listedAt: null, message: `Binance 永续返回 ${first.status}，稍后再试` };
  }
  const listedAt = Number((first.body as number[][])[0][0]) / 1000;
  const lastAt = Number((last.body as number[][])[0][0]) / 1000;
  if (nowSec - lastAt > 3 * 86400) return { ok: false, listedAt, message: `Binance 永续 ${id}USDT 已经 3 天没有新 K 线，可能已下架` };
  return { ok: true, listedAt, message: `Binance 永续 ${id}USDT` };
}

/** After the list changes: drop the cache and let the history jobs run again for the new coin. */
function changed() {
  memo = null;
  setState("job.historyComplete", "0");
  setState("job.oiArchiveComplete", "0");
}

export type CoinResult = { ok: true; coin: CoinRow; check?: ContractCheck } | { ok: false; error: string };

/** Add a coin (or show a hidden one again) after checking its contract. */
export async function addCoin(input: { id: string; name?: string; intro?: string }): Promise<CoinResult> {
  const id = input.id.trim().toUpperCase();
  if (!COIN_ID_RE.test(id)) return { ok: false, error: "代码只能是 2–15 位大写字母或数字，例如 SUI、1000PEPE" };
  const existing = allCoins().find((c) => c.id === id);
  if (existing?.enabled) return { ok: false, error: `${id} 已经在列表里` };
  if (activeCoins().length >= MAX_ACTIVE_COINS) return { ok: false, error: `最多同时显示 ${MAX_ACTIVE_COINS} 个币（服务器 2 核 / 1.6 GB），先隐藏一个` };
  const check = await checkContract(id);
  if (!check.ok) return { ok: false, error: check.message };
  const name = (input.name ?? "").trim().slice(0, 20) || existing?.name || id;
  const intro = (input.intro ?? "").trim().slice(0, 80) || existing?.intro || "";
  const d = getDb();
  const sort = ((d.prepare("SELECT MAX(sort) m FROM coins").get() as { m: number | null }).m ?? -1) + 1;
  if (existing) d.prepare("UPDATE coins SET enabled = 1, name = ?, intro = ?, sort = ?, listed_at = COALESCE(?, listed_at) WHERE id = ?").run(name, intro, sort, check.listedAt, id);
  else d.prepare("INSERT INTO coins (id, name, intro, enabled, sort, added_at, listed_at) VALUES (?, ?, ?, 1, ?, ?, ?)").run(id, name, intro, sort, Date.now(), check.listedAt);
  changed();
  return { ok: true, coin: allCoins().find((c) => c.id === id)!, check };
}

/** Hide or show a coin. Hiding keeps its stored data; showing again runs the contract check. */
export async function setCoinEnabled(id: string, enabled: boolean): Promise<CoinResult> {
  const c = allCoins().find((x) => x.id === id.toUpperCase());
  if (!c) return { ok: false, error: "没有这个币" };
  if (enabled) return addCoin({ id: c.id });
  if (!c.enabled) return { ok: true, coin: c };
  if (activeCoins().length <= 1) return { ok: false, error: "至少要留一个币" };
  getDb().prepare("UPDATE coins SET enabled = 0 WHERE id = ?").run(c.id);
  memo = null;
  return { ok: true, coin: allCoins().find((x) => x.id === c.id)! };
}

/** Rename, edit the description or move a coin up / down. */
export function updateCoin(id: string, patch: { name?: string; intro?: string; move?: -1 | 1 }): CoinResult {
  const list = allCoins();
  const i = list.findIndex((x) => x.id === id.toUpperCase());
  if (i < 0) return { ok: false, error: "没有这个币" };
  const c = list[i];
  const d = getDb();
  d.transaction(() => {
    if (patch.name !== undefined || patch.intro !== undefined) {
      d.prepare("UPDATE coins SET name = ?, intro = ? WHERE id = ?").run((patch.name ?? c.name).trim().slice(0, 20) || c.id, (patch.intro ?? c.intro).trim().slice(0, 80), c.id);
    }
    if (patch.move) {
      // renumber so neighbours swap even after old equal sort values
      const order = list.map((x) => x.id);
      const j = i + patch.move;
      if (j >= 0 && j < order.length) [order[i], order[j]] = [order[j], order[i]];
      const set = d.prepare("UPDATE coins SET sort = ? WHERE id = ?");
      order.forEach((x, k) => set.run(k, x));
    }
  })();
  memo = null;
  return { ok: true, coin: allCoins().find((x) => x.id === c.id)! };
}
