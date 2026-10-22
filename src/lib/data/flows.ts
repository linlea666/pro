import { getDb } from "../server/db.ts";
import { logger } from "../server/log.ts";
import { raiseAlert } from "../server/alert.ts";
import { binancePage, getJson } from "./klines.ts";
import type { FlowDay } from "../flows/stats.ts";

/**
 * Inputs of the ETF 买盘 page:
 * - US spot BTC ETF daily net flows from TFTC's free JSON (CC BY 4.0, aggregated from SoSoValue / Farside), in
 *   `etf_flows`; the first published value is kept next to the latest so revisions stay visible;
 * - hourly Coinbase BTC-USD, Coinbase USDT-USD and Binance BTCUSDT spot closes from 2024 on (`premium_hourly`), the
 *   history of the premarket premium;
 * - the same three prices every minute (`premium_minute`, 14 days), the live premium line.
 * All sources are public and keyless.
 */

export const FLOW_SOURCES = { etf: "tftc", coinbase: "coinbase", binance: "binance-spot" } as const;
const TFTC = "https://www.tftc.io/bitcoin-etf-flows/data.json";
const CB = "https://api.exchange.coinbase.com/products";
const BN_TICKER = "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT";
/** first hour of the premium history (spot ETFs started trading 2024-01-11) */
export const PREMIUM_FROM = Date.UTC(2024, 0, 1) / 1000;
const MINUTE_KEEP_SEC = 14 * 86400;
const H = 3600;

const num = (x: unknown) => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);

export interface EtfSyncResult {
  days: number;
  added: number;
  revised: number;
  lastDay: string | null;
  error?: string;
}

/** Download the whole flow file (about 200 KB) and upsert it. Early US holidays, stored as 0 by the source, are skipped. */
export async function syncEtfFlows(): Promise<EtfSyncResult> {
  const d = getDb();
  const now = Date.now();
  const r: EtfSyncResult = { days: 0, added: 0, revised: 0, lastDay: null };
  try {
    const body = (await getJson(FLOW_SOURCES.etf, TFTC, 30_000)) as { days?: { date: string; netFlowUsd: unknown; totalNetAssetsUsd: unknown; perEtfUsd?: Record<string, unknown> }[] };
    if (!Array.isArray(body.days)) throw new Error(`${FLOW_SOURCES.etf}: no days`);
    const get = d.prepare("SELECT flow FROM etf_flows WHERE day = ?");
    const ins = d.prepare("INSERT INTO etf_flows (day, flow, first_flow, aum, per_etf, first_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const upd = d.prepare("UPDATE etf_flows SET flow = ?, aum = ?, per_etf = ?, updated_at = ? WHERE day = ?");
    d.transaction(() => {
      for (const x of body.days!) {
        const flow = num(x.netFlowUsd);
        if (typeof x.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || flow == null || flow === 0) continue;
        const per: Record<string, number> = {};
        for (const [k, v] of Object.entries(x.perEtfUsd ?? {})) {
          const n = num(v);
          if (n != null && /^[A-Z]{2,6}$/.test(k)) per[k] = n;
        }
        const perJson = Object.keys(per).length ? JSON.stringify(per) : null;
        const old = get.get(x.date) as { flow: number } | undefined;
        r.days++;
        if (!old) {
          ins.run(x.date, flow, flow, num(x.totalNetAssetsUsd), perJson, now, now);
          r.added++;
        } else {
          if (Math.abs(old.flow - flow) >= 1) r.revised++;
          upd.run(flow, num(x.totalNetAssetsUsd), perJson, now, x.date);
        }
      }
    })();
  } catch (e) {
    r.error = (e as Error).message;
    logger.warn("datasource", "ETF 流入数据更新失败", { ...r });
    raiseAlert("datasource", "ETF 流入数据更新失败", { 错误: r.error });
  }
  r.lastDay = (d.prepare("SELECT MAX(day) day FROM etf_flows").get() as { day: string | null }).day;
  return r;
}

/** Every stored trading day, oldest first. */
export function etfFlowDays(): (FlowDay & { firstFlow: number })[] {
  const rows = getDb().prepare("SELECT day, flow, first_flow, aum, per_etf FROM etf_flows ORDER BY day").all() as {
    day: string;
    flow: number;
    first_flow: number;
    aum: number | null;
    per_etf: string | null;
  }[];
  return rows.map((x) => {
    let perEtf: Record<string, number> | null = null;
    try {
      perEtf = x.per_etf ? (JSON.parse(x.per_etf) as Record<string, number>) : null;
    } catch {}
    return { day: x.day, flow: x.flow, firstFlow: x.first_flow, aum: x.aum, perEtf };
  });
}

type Col = "cb" | "bn" | "usdt";

/** Coinbase hourly closes (at most 300 per request), as [open time, close]. */
async function coinbaseHours(product: string, start: number, end: number): Promise<[number, number][]> {
  const url = `${CB}/${product}/candles?granularity=3600&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
  const rows = (await getJson(FLOW_SOURCES.coinbase, url, 20_000)) as unknown[][];
  if (!Array.isArray(rows)) throw new Error(`${FLOW_SOURCES.coinbase}: unexpected response`);
  return rows.map((r) => [Number(r[0]), Number(r[4])] as [number, number]).filter(([t, c]) => Number.isFinite(t) && c > 0);
}

export interface PremiumSyncResult {
  requests: number;
  rows: number;
  complete: boolean;
  error?: string;
}

/**
 * Fill the hourly prices forward from the last stored hour of each column (from 2024 on an empty table), closed
 * hours only, within `budgetMs`. About 110 requests the first time, then one per column per hour.
 */
export async function syncPremiumHourly(opts: { budgetMs?: number } = {}): Promise<PremiumSyncResult> {
  const d = getDb();
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const lastClosed = Math.floor(Date.now() / 1000 / H) * H - H;
  const r: PremiumSyncResult = { requests: 0, rows: 0, complete: false };
  const stmt = {
    cb: d.prepare("INSERT INTO premium_hourly (t, cb) VALUES (?, ?) ON CONFLICT(t) DO UPDATE SET cb = excluded.cb"),
    usdt: d.prepare("INSERT INTO premium_hourly (t, usdt) VALUES (?, ?) ON CONFLICT(t) DO UPDATE SET usdt = excluded.usdt"),
    bn: d.prepare("INSERT INTO premium_hourly (t, bn) VALUES (?, ?) ON CONFLICT(t) DO UPDATE SET bn = excluded.bn"),
  };
  const save = (col: Col, rows: [number, number][]) => {
    d.transaction(() => {
      for (const [t, c] of rows) if (t <= lastClosed) stmt[col].run(t, c);
    })();
    r.rows += rows.length;
  };
  const next = (col: Col) => {
    const m = (d.prepare(`SELECT MAX(t) t FROM premium_hourly WHERE ${col} IS NOT NULL`).get() as { t: number | null }).t;
    return m == null ? PREMIUM_FROM : m + H;
  };
  let done = 0;
  try {
    for (const [col, product] of [["cb", "BTC-USD"], ["usdt", "USDT-USD"]] as const) {
      let s = next(col);
      while (s <= lastClosed && Date.now() < deadline) {
        const e = Math.min(lastClosed, s + 299 * H);
        const rows = await coinbaseHours(product, s, e);
        r.requests++;
        // Coinbase allows a few public requests a second
        await new Promise((f) => setTimeout(f, 350));
        save(col, rows);
        s = e + H;
      }
      if (s > lastClosed) done++;
    }
    let s = next("bn");
    while (s <= lastClosed && Date.now() < deadline) {
      const bars = await binancePage(FLOW_SOURCES.binance, "BTC", "1h", { startTime: s, endTime: lastClosed, limit: 1000 });
      r.requests++;
      if (!bars.length) break;
      save("bn", bars.map((b) => [b.t, b.c]));
      s = bars[bars.length - 1].t + H;
    }
    if (s > lastClosed) done++;
  } catch (e) {
    r.error = (e as Error).message;
    logger.warn("datasource", "溢价历史更新失败", { ...r });
    // rate limiting during the first backfill just ends this batch; the next tick goes on
    if (!/HTTP 429/.test(r.error)) raiseAlert("datasource", "溢价历史更新失败", { 错误: r.error });
  }
  r.complete = done === 3;
  return r;
}

export interface PriceTriple {
  /** Unix seconds: open time of the hourly bar, or the minute of the sample */
  t: number;
  cb: number;
  bn: number;
  usdt: number;
}

/** Hours with all three prices since `from` (Unix seconds), oldest first. */
export function premiumHours(from = PREMIUM_FROM): PriceTriple[] {
  return getDb()
    .prepare("SELECT t, cb, bn, usdt FROM premium_hourly WHERE t >= ? AND cb IS NOT NULL AND bn IS NOT NULL AND usdt IS NOT NULL ORDER BY t")
    .all(from) as PriceTriple[];
}

/** Minute samples since `from`, oldest first. */
export function premiumMinutes(from: number): PriceTriple[] {
  return getDb().prepare("SELECT t, cb, bn, usdt FROM premium_minute WHERE t >= ? ORDER BY t").all(from) as PriceTriple[];
}

/** One live sample of the three prices. */
export async function samplePremium(): Promise<PriceTriple> {
  const [cb, usdt, bn] = await Promise.all([
    getJson(FLOW_SOURCES.coinbase, `${CB}/BTC-USD/ticker`, 8_000),
    getJson(FLOW_SOURCES.coinbase, `${CB}/USDT-USD/ticker`, 8_000),
    getJson(FLOW_SOURCES.binance, BN_TICKER, 8_000),
  ]);
  const p = { cb: num((cb as { price?: unknown }).price), usdt: num((usdt as { price?: unknown }).price), bn: num((bn as { price?: unknown }).price) };
  if (!p.cb || !p.usdt || !p.bn) throw new Error("溢价采样：价格缺失");
  return { t: Math.floor(Date.now() / 60_000) * 60, cb: p.cb, bn: p.bn, usdt: p.usdt };
}

const g = globalThis as unknown as { __slPremium?: NodeJS.Timeout; __slPremiumFails?: number };

/** Sample the premium once a minute in the server process (3 public requests each time). */
export function startPremiumSampler() {
  if (g.__slPremium) return;
  g.__slPremiumFails = 0;
  const ins = () => getDb().prepare("INSERT OR REPLACE INTO premium_minute (t, cb, bn, usdt) VALUES (?, ?, ?, ?)");
  const run = async () => {
    try {
      const s = await samplePremium();
      ins().run(s.t, s.cb, s.bn, s.usdt);
      if (s.t % 3600 === 0) getDb().prepare("DELETE FROM premium_minute WHERE t < ?").run(s.t - MINUTE_KEEP_SEC);
      g.__slPremiumFails = 0;
    } catch (e) {
      g.__slPremiumFails = (g.__slPremiumFails ?? 0) + 1;
      // a single failed minute is normal; ten in a row means the live premium has stopped
      if (g.__slPremiumFails === 10) raiseAlert("datasource", "溢价实时采样连续失败", { 错误: (e as Error).message });
    }
  };
  // align to a few seconds past each minute
  const first = 60_000 - (Date.now() % 60_000) + 5_000;
  setTimeout(() => {
    run();
    g.__slPremium = setInterval(run, 60_000);
    g.__slPremium.unref?.();
  }, first).unref?.();
}

/** Last stored day and sample times, for the CLI and the diagnosis. */
export function flowsFreshness(): { lastDay: string | null; days: number; lastHour: number | null; hours: number; lastMinute: number | null } {
  const d = getDb();
  const a = d.prepare("SELECT MAX(day) lastDay, COUNT(*) days FROM etf_flows").get() as { lastDay: string | null; days: number };
  const b = d.prepare("SELECT MAX(t) lastHour, COUNT(*) hours FROM premium_hourly WHERE cb IS NOT NULL AND bn IS NOT NULL AND usdt IS NOT NULL").get() as { lastHour: number | null; hours: number };
  const c = d.prepare("SELECT MAX(t) lastMinute FROM premium_minute").get() as { lastMinute: number | null };
  return { ...a, ...b, ...c };
}
