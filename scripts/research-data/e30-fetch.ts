/**
 * E30 的数据：Binance 永续日线和 4 小时 K 线（带成交额）、资金费率，从公开归档下载，存成 JSON。
 *   node --experimental-strip-types scripts/research-data/e30-fetch.ts <dataDir> [--end 2026-10-26] [--coins BTC,ETH]
 * 写到 <dataDir>/e30/<COIN>.json：{ d1: [[t,o,h,l,c,qv]], h4: [...], funding: [[t,rate]] }，t 为秒。
 * 默认 10 个研究币（RESEARCH_COINS）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { unzipSingle } from "../../src/lib/data/archive.ts";
import { BUILTIN_COINS } from "../../src/lib/symbols.ts";

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.log("usage: node --experimental-strip-types scripts/research-data/e30-fetch.ts <dataDir> [--end YYYY-MM-DD] [--coins BTC,ETH]");
  process.exit(1);
}
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const END = arg("--end") ?? new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const COINS = arg("--coins")?.split(",") ?? BUILTIN_COINS.map((c) => c.id);
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

async function klines(sym: string, tf: string): Promise<number[][]> {
  const paths = [...months.map((m) => `futures/um/monthly/klines/${sym}/${tf}/${sym}-${tf}-${m}.zip`), ...days.map((d) => `futures/um/daily/klines/${sym}/${tf}/${sym}-${tf}-${d}.zip`)];
  const texts = await Promise.all(paths.map(get));
  const rows: number[][] = [];
  for (const t of texts)
    for (const l of (t ?? "").split(/\r?\n/)) {
      const f = l.split(",");
      if (!/^\d+$/.test(f[0])) continue;
      rows.push([Math.floor(Number(f[0]) / 1000), +f[1], +f[2], +f[3], +f[4], +f[7]]);
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

mkdirSync(`${dir}/e30`, { recursive: true });
for (const coin of COINS) {
  const sym = `${coin}USDT`;
  const [d1, h4, fr] = await Promise.all([klines(sym, "1d"), klines(sym, "4h"), funding(sym)]);
  writeFileSync(`${dir}/e30/${coin}.json`, JSON.stringify({ d1, h4, funding: fr }));
  console.log(`${coin}: 日线 ${d1.length}，4 小时 ${h4.length}，资金费率 ${fr.length}`);
}
