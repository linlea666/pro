/**
 * Build a local research database from Binance's public archive (data.binance.vision), which the cloud
 * container can reach even though fapi.binance.com answers 451 there.
 *
 *   node --experimental-strip-types scripts/research-data/build.ts <dataDir> [--end 2026-10-19]
 *
 * Fills `candles` and `funding_rates` in <dataDir>/signallight.db (created if missing):
 * - perp (binance-futures) for every coin: 15m from 2022-01, 1h from 2020-01, 4h from 2021-10, 1d / 1w from 2019-09;
 * - mark price (binance-mark) 1h / 4h for BTC and ETH from 2024-10;
 * - spot (binance-spot) 15m / 1h for BTC and ETH from 2022-01 (E19's spot sign);
 * - funding settlements from 2021-12.
 * Monthly files up to the month before --end, daily files for --end's month. Hourly open interest comes from
 * `signallight history --sync` / archive.ts instead.
 *
 * Never start the web server on this database: its daily cleanup prunes candles to KEEP_DAYS. Run research on it
 * with the CLI or a script, and copy it first if a server must run on it.
 */
export {};

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.log("usage: node --experimental-strip-types scripts/research-data/build.ts <dataDir> [--end YYYY-MM-DD]");
  process.exit(1);
}
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = "error";
const endArg = process.argv.indexOf("--end");
const END = endArg > 0 ? process.argv[endArg + 1] : new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

const { unzipSingle } = await import("../../src/lib/data/archive.ts");
const { store } = await import("../../src/lib/data/klines.ts");
const { getDb } = await import("../../src/lib/server/db.ts");
const { RESEARCH_COINS } = await import("../../src/lib/symbols.ts");
type Timeframe = import("../../src/lib/types.ts").Timeframe;
type Candle = import("../../src/lib/types.ts").Candle;

const BASE = "https://data.binance.vision/data";
async function get(path: string): Promise<string | null> {
  const res = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return unzipSingle(new Uint8Array(await res.arrayBuffer()));
}

const endMonth = END.slice(0, 7);
/** months from `from` up to the one before END's */
function months(from: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  for (;;) {
    const s = `${y}-${String(m).padStart(2, "0")}`;
    if (s >= endMonth) return out;
    out.push(s);
    if (++m > 12) (m = 1), y++;
  }
}
const days: string[] = [];
for (let d = 1; d <= Number(END.slice(8, 10)); d++) days.push(`${endMonth}-${String(d).padStart(2, "0")}`);

// spot files switched to microseconds in 2025
const sec = (x: string) => {
  const n = Number(x);
  return Math.floor(n > 1e14 ? n / 1e6 : n / 1000);
};
const parse = (csv: string, withTbv: boolean): Candle[] =>
  csv
    .split(/\r?\n/)
    .map((l) => l.split(","))
    .filter((f) => /^\d+$/.test(f[0]))
    .map((f) => ({ t: sec(f[0]), o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5], ...(withTbv && f[9] ? { tbv: +f[9] } : {}) }));

const jobs: (() => Promise<void>)[] = [];
let rows = 0, miss = 0, done = 0;
type Market = "futures/um" | "spot";
function klines(market: Market, kind: "klines" | "markPriceKlines", coin: string, tf: Timeframe, from: string, daily = true) {
  const source = market === "spot" ? "binance-spot" : kind === "klines" ? "binance-futures" : "binance-mark";
  const one = (path: string) => async () => {
    const t = await get(path);
    if (!t) return void miss++;
    const b = parse(t, kind === "klines");
    store(coin, tf, source, b);
    rows += b.length;
  };
  for (const m of months(from)) jobs.push(one(`${market}/monthly/${kind}/${coin}USDT/${tf}/${coin}USDT-${tf}-${m}.zip`));
  // weekly bars only come in monthly files (the weeks that start in that month)
  if (daily && tf !== "1w") for (const d of days) jobs.push(one(`${market}/daily/${kind}/${coin}USDT/${tf}/${coin}USDT-${tf}-${d}.zip`));
}

const START: Partial<Record<Timeframe, string>> = { "15m": "2022-01", "1h": "2020-01", "4h": "2021-10", "1d": "2019-09", "1w": "2019-09" };
for (const coin of RESEARCH_COINS) for (const [tf, from] of Object.entries(START)) klines("futures/um", "klines", coin, tf as Timeframe, from);
for (const coin of ["BTC", "ETH"]) {
  for (const tf of ["1h", "4h"] as const) klines("futures/um", "markPriceKlines", coin, tf, "2024-10");
  for (const tf of ["15m", "1h"] as const) klines("spot", "klines", coin, tf, "2022-01");
}
const fins = getDb().prepare("INSERT OR REPLACE INTO funding_rates (coin, source, t, rate, mark_price) VALUES (?, 'binance-futures', ?, ?, NULL)");
for (const coin of RESEARCH_COINS)
  for (const m of months("2021-12"))
    jobs.push(async () => {
      const t = await get(`futures/um/monthly/fundingRate/${coin}USDT/${coin}USDT-fundingRate-${m}.zip`);
      if (!t) return void miss++;
      for (const f of t.split(/\r?\n/).map((l) => l.split(","))) if (/^\d+$/.test(f[0])) fins.run(coin, sec(f[0]), Number(f[2]));
    });

console.log(`${jobs.length} files, through ${END}`);
let next = 0;
await Promise.all(
  Array.from({ length: 12 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      for (let a = 0; a < 3; a++) {
        try {
          await job();
          break;
        } catch (e) {
          if (a === 2) console.log("failed:", (e as Error).message);
        }
      }
      if (++done % 200 === 0) console.log(`${done} / ${jobs.length}, ${rows} bars, ${miss} missing`);
    }
  }),
);
console.log(`done: ${rows} bars, ${miss} files missing on the archive`);

// the archive stops publishing weekly files at some point: build the later weeks (Monday, UTC) from the daily bars
const loadAll = (coin: string, tf: Timeframe) =>
  getDb().prepare("SELECT t, o, h, l, c, v FROM candles WHERE coin = ? AND tf = ? AND source = 'binance-futures' ORDER BY t").all(coin, tf) as Candle[];
for (const coin of RESEARCH_COINS) {
  const lastWeek = loadAll(coin, "1w").at(-1)?.t ?? 0;
  const weeks: Candle[] = [];
  for (const d of loadAll(coin, "1d")) {
    const monday = d.t - (((new Date(d.t * 1000).getUTCDay() + 6) % 7) * 86400);
    if (monday <= lastWeek) continue;
    const w = weeks.at(-1);
    if (w && w.t === monday) Object.assign(w, { h: Math.max(w.h, d.h), l: Math.min(w.l, d.l), c: d.c, v: w.v + d.v });
    else weeks.push({ t: monday, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v });
  }
  if (weeks.length) store(coin, "1w", "binance-futures", weeks);
}
console.table(getDb().prepare("SELECT source, tf, COUNT(DISTINCT coin) coins, COUNT(*) n, date(MIN(t), 'unixepoch') first, date(MAX(t), 'unixepoch') last FROM candles GROUP BY source, tf").all());
