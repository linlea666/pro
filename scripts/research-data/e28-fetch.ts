/**
 * E28 的数据：Binance 永续 1 分钟 K 线（带主动买入量），从公开归档下载，存成每个币一个二进制文件
 * （Float64，每根 7 个数：t、o、h、l、c、v、tbv），不进数据库。
 *   node --experimental-strip-types scripts/research-data/e28-fetch.ts <dataDir> [--end 2026-10-24]
 * 写到 <dataDir>/m1/<COIN>.bin，范围同 build.ts 的 15 分钟（2022-01 起）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { unzipSingle } from "../../src/lib/data/archive.ts";
import { RESEARCH_COINS } from "../../src/lib/symbols.ts";

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.log("usage: node --experimental-strip-types scripts/research-data/e28-fetch.ts <dataDir> [--end YYYY-MM-DD]");
  process.exit(1);
}
const endArg = process.argv.indexOf("--end");
const END = endArg > 0 ? process.argv[endArg + 1] : new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const endMonth = END.slice(0, 7);
const months: string[] = [];
for (let y = 2022, m = 1; ; ) {
  const s = `${y}-${String(m).padStart(2, "0")}`;
  if (s >= endMonth) break;
  months.push(s);
  if (++m > 12) (m = 1), y++;
}
const days: string[] = [];
for (let d = 1; d <= Number(END.slice(8, 10)); d++) days.push(`${endMonth}-${String(d).padStart(2, "0")}`);

const BASE = "https://data.binance.vision/data/futures/um";
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

mkdirSync(`${dir}/m1`, { recursive: true });
for (const coin of RESEARCH_COINS) {
  const sym = `${coin}USDT`;
  const paths = [...months.map((m) => `monthly/klines/${sym}/1m/${sym}-1m-${m}.zip`), ...days.map((d) => `daily/klines/${sym}/1m/${sym}-1m-${d}.zip`)];
  const parts: number[][] = new Array(paths.length);
  let next = 0, miss = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < paths.length) {
        const k = next++;
        const t = await get(paths[k]);
        const rows: number[] = [];
        if (!t) miss++;
        else
          for (const l of t.split(/\r?\n/)) {
            const f = l.split(",");
            if (!/^\d+$/.test(f[0])) continue;
            rows.push(Math.floor(Number(f[0]) / 1000), +f[1], +f[2], +f[3], +f[4], +f[5], f[9] ? +f[9] : NaN);
          }
        parts[k] = rows;
      }
    }),
  );
  const flat = new Float64Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    flat.set(p, o);
    o += p.length;
  }
  writeFileSync(`${dir}/m1/${coin}.bin`, flat);
  console.log(`${coin}: ${flat.length / 7} bars, ${miss} files missing`);
}
