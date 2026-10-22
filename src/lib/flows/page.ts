import { logger } from "../server/log.ts";
import { etfFlowDays, premiumHours, premiumMinutes } from "../data/flows.ts";
import {
  afterTable,
  corr,
  FLOW_FACTS,
  FLOW_RULES,
  flowNow,
  nominalPremium,
  premarketDays,
  premiumZ,
  quintileMeans,
  truePremium,
  zBand,
  zSeries,
  zTable,
  type AfterRow,
  type FlowNow,
  type ZBand,
  type ZDay,
  type ZRow,
} from "./stats.ts";

/**
 * What GET /api/flows returns: the ETF 买盘 page. Flows and the Z table change once a day, the live premium every
 * minute; the whole page is rebuilt at most once a minute.
 */
export interface FlowsPage {
  fetchedAt: number;
  now: FlowNow;
  /** the latest day's revision: first published value against the current one */
  firstFlow: number;
  /** funds of the latest day, largest absolute flow first */
  funds: { name: string; flow: number }[];
  /** the last 365 trading days for the chart: flow, first published flow and the BTC close at 21:00 UTC that day */
  bars: { day: string; flow: number; price: number | null }[];
  radar: Radar;
  /** days like the latest one (same flow band) and what followed, against all days */
  similar: { band: FlowBand; label: string; rows: AfterRow[]; all: AfterRow[] };
  /** flows follow the price: correlations and the flow by fifth of the same-day / next-day move */
  follows: { sameDay: number; prev5: number; next1: number; next7: number; bySameDay: Quint[]; byNextDay: Quint[]; days: number };
  facts: typeof FLOW_FACTS;
  source: string;
}

type Quint = { lo: number; hi: number; mean: number; n: number };
export type FlowBand = "大额流入" | "大额流出" | "中间";

export interface Radar {
  /** UTC day the radar is about */
  day: string;
  /** before 北京 16:00 the day's premarket has not started; 16:00–21:00 rolling; after 21:00 final */
  phase: "未开始" | "盘前滚动" | "已定盘";
  weekend: boolean;
  /** today's premarket premium and Z (rolling or final); null before the window opens */
  z: number | null;
  prem: number | null;
  band: ZBand | null;
  /** the band's historical share of inflow days, %, and the all-days share */
  inflowPct: number | null;
  baseInflowPct: number | null;
  /** the latest final premarket day before today */
  prevDay: { day: string; z: number; prem: number } | null;
  /** the last minute sample */
  live: { t: number; prem: number; nominal: number; usdtDev: number; cb: number; bn: number; usdt: number } | null;
  /** today's minute samples from 北京 16:00 (or the last 6 hours), [t, premium] */
  minutes: [number, number][];
  /** the last 120 premarket days */
  history: { day: string; prem: number; z: number }[];
  table: ZRow[];
  /** days in the table */
  tableDays: number;
}

const H = 3600;
const DAY = 86400;
const isoDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const dayT = (day: string, h = 0) => Date.parse(`${day}T00:00:00Z`) / 1000 + h * H;

export class FlowsEmptyError extends Error {}

let cache: { at: number; page: FlowsPage } | null = null;

export async function getFlowsPage(): Promise<FlowsPage> {
  if (cache && Date.now() - cache.at < 60_000) return cache.page;
  const t0 = Date.now();
  const page = buildFlowsPage(Date.now() / 1000);
  cache = { at: Date.now(), page };
  logger.debug("engine", "ETF 买盘页已计算", { ms: Date.now() - t0 });
  return page;
}

/** Everything from the stored data at time `nowSec` (exported for the CLI). */
export function buildFlowsPage(nowSec: number): FlowsPage {
  const days = etfFlowDays();
  const now = flowNow(days);
  if (!now) throw new FlowsEmptyError("ETF 流入数据还没下载齐：服务器启动后会自动下载（也可以运行 signallight flows --sync）");
  const hours = premiumHours();
  // Binance close at the end of the hour that opened at `t - 1h`, i.e. the price at time t
  const price = new Map<number, number>();
  for (const h of hours) price.set(h.t + H, h.bn);
  const at = (t: number) => price.get(t) ?? null;
  const change = (a: number, b: number) => {
    const x = at(a);
    const y = at(b);
    return x && y ? y / x - 1 : null;
  };

  // ---- flows and the price ----
  const last = days[days.length - 1];
  const bars = days.slice(-365).map((d) => ({ day: d.day, flow: d.flow, price: at(dayT(d.day, 21)) }));
  const funds = Object.entries(last.perEtf ?? {})
    .filter(([, v]) => v !== 0)
    .map(([name, flow]) => ({ name, flow }))
    .sort((a, b) => Math.abs(b.flow) - Math.abs(a.flow));

  // each day from the 121st: its flow band and the BTC change from the next day's 13:00 UTC (when the number is known)
  const rows: { band: FlowBand; dec: number; flow: number; same: number | null; prev5: number | null }[] = [];
  for (let i = FLOW_RULES.lookback + 6; i < days.length; i++) {
    const f = flowNow(days, i)!;
    const band: FlowBand = f.pct >= 0.9 ? "大额流入" : f.pct <= 0.1 ? "大额流出" : "中间";
    const d21 = dayT(days[i].day, 21);
    rows.push({ band, dec: dayT(days[i].day, 0) + DAY + FLOW_RULES.premarketFinalHour * H, flow: f.flow, same: change(d21 - DAY, d21), prev5: change(d21 - 6 * DAY, d21 - DAY) });
  }
  const horizons = [1, 3, 7];
  const pick = (r: (typeof rows)[number], h: number) => (r.dec + h * DAY <= nowSec ? change(r.dec, r.dec + h * DAY) : null);
  const curBand = rows[rows.length - 1].band;
  const similar = {
    band: curBand,
    label: curBand === "大额流入" ? "当天流入在最近 120 天前 10% 的日子" : curBand === "大额流出" ? "当天流出在最近 120 天后 10% 的日子" : "当天流入大小居中的日子",
    rows: afterTable(rows.filter((r) => r.band === curBand), horizons, pick),
    all: afterTable(rows, horizons, pick),
  };
  const ok = rows.filter((r) => r.same != null && r.prev5 != null && pick(r, 1) != null);
  const ok7 = ok.filter((r) => pick(r, 7) != null);
  const follows = {
    sameDay: corr(ok.map((r) => r.flow), ok.map((r) => r.same!)),
    prev5: corr(ok.map((r) => r.flow), ok.map((r) => r.prev5!)),
    next1: corr(ok.map((r) => r.flow), ok.map((r) => pick(r, 1)!)),
    next7: corr(ok7.map((r) => r.flow), ok7.map((r) => pick(r, 7)!)),
    bySameDay: quintileMeans(ok.map((r) => r.same! * 100), ok.map((r) => r.flow)),
    byNextDay: quintileMeans(ok.map((r) => pick(r, 1)! * 100), ok.map((r) => r.flow)),
    days: ok.length,
  };

  // ---- the premarket radar ----
  const hp = hours.map((h) => ({ t: h.t, prem: truePremium(h.cb, h.bn, h.usdt) }));
  const today = isoDay(nowSec);
  const finalAt = dayT(today, FLOW_RULES.premarketFinalHour);
  const startAt = dayT(today, FLOW_RULES.premarketHours[0]);
  // only fully closed premarket days count as history; today's final value is the hourly mean once 13:00 UTC has passed
  const pmAll = premarketDays(hp);
  const pmPast = pmAll.filter((p) => p.day < today);
  const zs = zSeries(pmAll.filter((p) => p.day < today || nowSec >= finalAt));
  const flowBy = new Map(days.map((d) => [d.day, d.flow]));
  const zDays: ZDay[] = zs
    .filter((z) => z.day < today)
    // US holidays have a premarket premium but no flow: the table counts days with a published flow
    .filter((z) => flowBy.has(z.day))
    .map((z) => ({ day: z.day, z: z.z, flow: flowBy.get(z.day)!, session: change(dayT(z.day, FLOW_RULES.premarketFinalHour), dayT(z.day, FLOW_RULES.premarketFinalHour + FLOW_RULES.sessionHours)) }));
  const table = zTable(zDays);

  const mins = premiumMinutes(Math.min(startAt, Math.floor(nowSec) - 6 * H));
  const lm = mins[mins.length - 1];
  const live = lm && nowSec - lm.t < 10 * 60
    ? { t: lm.t, prem: truePremium(lm.cb, lm.bn, lm.usdt), nominal: nominalPremium(lm.cb, lm.bn), usdtDev: lm.usdt - 1, cb: lm.cb, bn: lm.bn, usdt: lm.usdt }
    : null;
  const phase: Radar["phase"] = nowSec < startAt ? "未开始" : nowSec < finalAt ? "盘前滚动" : "已定盘";
  let prem: number | null = null;
  if (phase === "已定盘") prem = pmAll.find((p) => p.day === today)?.prem ?? null;
  else if (phase === "盘前滚动") {
    // rolling: the minute samples so far in the window, or the closed hourly bars when the sampler has a gap
    const m = mins.filter((x) => x.t >= startAt).map((x) => truePremium(x.cb, x.bn, x.usdt));
    const hh = hp.filter((x) => x.t >= startAt && x.t < finalAt).map((x) => x.prem);
    const a = m.length >= 15 ? m : hh;
    if (a.length) prem = a.reduce((s, x) => s + x, 0) / a.length;
  }
  const z = prem == null ? null : premiumZ(prem, pmPast.map((p) => p.prem));
  const band = z == null ? null : zBand(z);
  const weekday = new Date(dayT(today) * 1000).getUTCDay();
  const prevZ = zs.filter((x) => x.day < today).at(-1);
  const radar: Radar = {
    day: today,
    phase,
    weekend: weekday === 0 || weekday === 6,
    z,
    prem,
    band,
    inflowPct: band ? (table.find((r) => r.band === band)?.inflowPct ?? null) : null,
    baseInflowPct: table[table.length - 1].inflowPct,
    prevDay: prevZ ? { day: prevZ.day, z: prevZ.z, prem: prevZ.prem } : null,
    live,
    minutes: mins.filter((x) => x.t >= Math.min(startAt, Math.floor(nowSec) - 6 * H)).map((x) => [x.t, truePremium(x.cb, x.bn, x.usdt)] as [number, number]),
    history: zs.filter((x) => x.day < today).slice(-120),
    table,
    tableDays: zDays.length,
  };

  return {
    fetchedAt: Date.now(),
    now,
    firstFlow: (last as { firstFlow?: number }).firstFlow ?? last.flow,
    funds,
    bars,
    radar,
    similar,
    follows,
    facts: FLOW_FACTS,
    source: "The Commoner Bitcoin ETF Tracker by TFTC（tftc.io/bitcoin-etf-flows，CC BY 4.0，来源 SoSoValue / Farside）",
  };
}
