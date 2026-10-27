/**
 * E29 的数据：Binance 永续和现货日线（带主动买入成交额）、永续资金费率，从公开归档下载，存成 JSON。
 *   node --experimental-strip-types scripts/research-data/e29-fetch.ts <dataDir> [--end 2026-10-26]
 * 写到 <dataDir>/e29/<COIN>.json：{ perp: [[t,o,h,l,c,qv,tbqv]], spot: [...], funding: [[t,rate]] }，t 为秒。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { unzipSingle } from "../../src/lib/data/archive.ts";

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.log("usage: node --experimental-strip-types scripts/research-data/e29-fetch.ts <dataDir> [--end YYYY-MM-DD]");
  process.exit(1);
}
const endArg = process.argv.indexOf("--end");
const END = endArg > 0 ? process.argv[endArg + 1] : new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const endMonth = END.slice(0, 7);
const months: string[] = [];
for (let y = 2019, m = 9; ; ) {
  const s = `${y}-${String(m).padStart(2, "0")}`;
  if (s >= endMonth) break;
  months.push(s);
  if (++m > 12) (m = 1), y++;
}
const days: string[] = [];
for (let d = 1; d <= Number(END.slice(8, 10)); d++) days.push(`${endMonth}-${String(d).padStart(2, "0")}`);

const BASE = "https://data.binance.vision/data";
async function get(path: string): Promise<string | null> {
  for (let a = 0; ; a++) {
    try {
      const res = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      return unzipSingle(new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      if (a === 3) throw e;
    }
  }
}

async function klines(market: "futures/um" | "spot", sym: string): Promise<number[][]> {
  const paths = [...months.map((m) => `${market}/monthly/klines/${sym}/1d/${sym}-1d-${m}.zip`), ...days.map((d) => `${market}/daily/klines/${sym}/1d/${sym}-1d-${d}.zip`)];
  const texts = await Promise.all(paths.map(get));
  const rows: number[][] = [];
  for (const t of texts)
    for (const l of (t ?? "").split(/\r?\n/)) {
      const f = l.split(",");
      if (!/^\d+$/.test(f[0])) continue;
      let ts = Number(f[0]);
      if (ts > 1e14) ts = Math.floor(ts / 1000); // 现货 2025 年起是微秒
      rows.push([Math.floor(ts / 1000), +f[1], +f[2], +f[3], +f[4], +f[7], +f[10]]);
    }
  rows.sort((a, b) => a[0] - b[0]);
  return rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]);
}

async function funding(sym: string): Promise<number[][]> {
  const texts = await Promise.all(months.map((m) => get(`futures/um/monthly/fundingRate/${sym}/${sym}-fundingRate-${m}.zip`)));
  const rows: number[][] = [];
  for (const t of texts)
    for (const l of (t ?? "").split(/\r?\n/)) {
      const f = l.split(",");
      if (!/^\d+$/.test(f[0])) continue;
      rows.push([Math.floor(Number(f[0]) / 1000), +f[2]]);
    }
  return rows.sort((a, b) => a[0] - b[0]);
}

mkdirSync(`${dir}/e29`, { recursive: true });
for (const coin of ["BTC", "ETH"]) {
  const sym = `${coin}USDT`;
  const [perp, spot, fr] = await Promise.all([klines("futures/um", sym), klines("spot", sym), funding(sym)]);
  writeFileSync(`${dir}/e29/${coin}.json`, JSON.stringify({ perp, spot, funding: fr }));
  console.log(`${coin}: perp ${perp.length} 天，现货 ${spot.length} 天，资金费率 ${fr.length} 条`);
}
