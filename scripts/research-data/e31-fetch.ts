/**
 * E31b 的数据：Binance 永续 1 小时和 15 分钟 K 线，从公开归档下载，存成 JSON（加仓确认换成小周期收盘时用）。
 *   node --experimental-strip-types scripts/research-data/e31-fetch.ts <dataDir> [--end 2026-10-27] [--coins BTC,ETH]
 * 写到 <dataDir>/e31/<COIN>.json：{ h1: [[t,o,h,l,c,qv]], m15: [...] }，t 为秒。默认 10 个研究币。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { unzipSingle } from "../../src/lib/data/archive.ts";
import { BUILTIN_COINS } from "../../src/lib/symbols.ts";

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.log("usage: node --experimental-strip-types scripts/research-data/e31-fetch.ts <dataDir> [--end YYYY-MM-DD] [--coins BTC,ETH]");
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

mkdirSync(`${dir}/e31`, { recursive: true });
for (const coin of COINS) {
  const sym = `${coin}USDT`;
  const [h1, m15] = await Promise.all([klines(sym, "1h"), klines(sym, "15m")]);
  writeFileSync(`${dir}/e31/${coin}.json`, JSON.stringify({ h1, m15 }));
  console.log(`${coin}: 1 小时 ${h1.length}，15 分钟 ${m15.length}`);
}
