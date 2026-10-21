import { logger } from "../server/log.ts";
import { getSetting } from "../server/settings.ts";
import { fngPoints, spotFreshness, spotSeries } from "../data/spot.ts";
import { getKlines } from "../data/klines.ts";
import {
  capZonePrices,
  EPISODE_ZONES,
  episodes,
  fngBlock,
  reserveSignal,
  rulers,
  SPOT_RULES,
  spotNow,
  spotRefs,
  type CapZonePrice,
  type EpisodeResult,
  type FngBlock,
  type PriceRef,
  type SpotNow,
} from "./valuation.ts";
import { parseOpinionZones } from "./opinion.ts";
import { STACK_DEFAULTS, type SpotHistoryWire } from "./stack.ts";

/**
 * What GET /api/spot returns: the 现货囤币 page's valuation (daily, recomputed once per new stored day), the live
 * price (refreshed every 10 minutes), the opinion zones, the episode tables, and the daily history the page
 * needs to replay an accumulation plan in the browser.
 */
export interface SpotPage {
  asset: "BTC";
  /** last day with a Coin Metrics price (UTC) */
  asOfDay: string;
  /** when this valuation was computed, ms */
  fetchedAt: number;
  now: SpotNow;
  live: SpotLivePrice;
  opinion: { source: string; date: string; zones: CapZonePrice[] };
  episodes: EpisodeResult[];
  fng: FngBlock | null;
  /** reference prices for the planner (computed lines and the opinion zones' edges) */
  refs: PriceRef[];
  /** the planner's reserve trigger today: the higher of the 200-week average and the realized price */
  reservePrice: number | null;
  /** day-by-day price and reserve signal (below the 200-week average or MVRV < 1) for the replay */
  history: SpotHistoryWire;
  rules: typeof SPOT_RULES;
  stackDefaults: typeof STACK_DEFAULTS;
}

export interface SpotLivePrice {
  price: number;
  /** binance-futures etc.; "coinmetrics" when only the daily close is available */
  source: string;
  /** ms */
  at: number;
}

export class SpotEmptyError extends Error {}

const LIVE_TTL_MS = 10 * 60_000;
const g = globalThis as { __slSpot?: { key: string; value: Omit<SpotPage, "live"> }; __slSpotLive?: { at: number; value: SpotLivePrice } };

/** Prices in the history: 2 decimals (6 significant digits under 100, so the 2010 cents survive). */
const roundPrice = (x: number) => (x >= 100 ? Math.round(x * 100) / 100 : Number(x.toPrecision(6)));

function build(): Omit<SpotPage, "live"> {
  const s = spotSeries("BTC");
  if (!s) throw new SpotEmptyError("现货估值数据还没下载，服务器会在后台自动下载");
  const t = Date.now();
  const r = rulers(s);
  const now = spotNow(s, r);
  const raw = getSetting("spot.opinionZones");
  const op = parseOpinionZones(raw);
  if (op.bad) logger.warn("system", "观点区间设置无法解析，改用默认值", { value: String(raw).slice(0, 200) });
  const zones = now.supply ? capZonePrices(now.supply, op.value.zones) : [];
  const signal = reserveSignal(r);
  const reservePrice = Math.max(now.wma.wma200 ?? 0, now.mvrv.realizedPrice ?? 0) || null;
  const value = {
    asset: "BTC" as const,
    asOfDay: now.day,
    fetchedAt: Date.now(),
    now,
    opinion: { source: op.value.source, date: op.value.date, zones },
    episodes: EPISODE_ZONES.map((z) => episodes(s, z.key, r)),
    fng: fngBlock(fngPoints("BTC")),
    refs: spotRefs(now, zones),
    reservePrice,
    history: { start: s.day[0], price: s.price.map(roundPrice), reserve: signal.map((b) => (b ? "1" : "0")).join("") },
    rules: SPOT_RULES,
    stackDefaults: STACK_DEFAULTS,
  };
  logger.debug("engine", "现货估值已计算", { day: now.day, durationMs: Date.now() - t });
  return value;
}

async function livePrice(fallback: { price: number; day: string }): Promise<SpotLivePrice> {
  const hit = g.__slSpotLive;
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.value;
  let value: SpotLivePrice;
  try {
    // the 1-hour series the coin pages keep warm; a cold cache is one request, capped at 5 seconds here
    const k = await Promise.race([getKlines("BTC", "1h"), new Promise<never>((_, no) => setTimeout(() => no(new Error("超时 5000ms")), 5000).unref?.())]);
    const last = k.candles[k.candles.length - 1];
    if (!last) throw new Error("no candles");
    value = { price: last.c, source: k.source, at: k.fetchedAt };
  } catch (e) {
    logger.debug("datasource", "现货页实时价格获取失败，用日线收盘价", { error: (e as Error).message });
    value = { price: fallback.price, source: "coinmetrics", at: Date.parse(`${fallback.day}T23:59:59Z`) };
  }
  g.__slSpotLive = { at: Date.now(), value };
  return value;
}

/** The page's data; the valuation is cached per stored day (and opinion setting), the live price for 10 minutes. */
export async function getSpotPage(): Promise<SpotPage> {
  const f = spotFreshness("BTC");
  if (!f.lastDay) throw new SpotEmptyError("现货估值数据还没下载，服务器会在后台自动下载");
  const key = `${f.lastDay}|${f.lastFngDay}|${getSetting("spot.opinionZones")}`;
  if (g.__slSpot?.key !== key) g.__slSpot = { key, value: build() };
  const v = g.__slSpot.value;
  return { ...v, live: await livePrice({ price: v.now.price, day: v.asOfDay }) };
}
