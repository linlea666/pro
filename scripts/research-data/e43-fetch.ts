/**
 * E43 的数据：Binance 永续每小时持仓量（公开归档 daily/metrics 的 5 分钟行，取每小时第一行），BTC 2020-09 起、ETH 2021-12 起。
 *   node --experimental-strip-types scripts/research-data/e43-fetch.ts <dataDir> [--end 2026-11-05] [--coins BTC,ETH]
 * 写到 <dataDir>/e43/<COIN>-oi.json：[[t, oi]]，t 为秒。K 线和资金费率用 e30-fetch.ts / e31-fetch.ts。
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fetchArchive, hourlyOpenInterest } from "../../src/lib/data/archive.ts";

const dir = process.argv[2];
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const END = arg("--end") ?? new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
const COINS = arg("--coins")?.split(",") ?? ["BTC", "ETH"];
mkdirSync(`${dir}/e43`, { recursive: true });
const days: string[] = [];
for (let t = Date.parse("2020-09-01T00:00:00Z"); t <= Date.parse(END + "T00:00:00Z"); t += 86400e3) days.push(new Date(t).toISOString().slice(0, 10));
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const x = items[i++];
      for (let a = 0; ; a++) {
        try { await f(x); break; } catch (e) { if (a >= 4) { console.error("fail", x, String(e)); break; } await new Promise((r) => setTimeout(r, 1000 * 2 ** a)); }
      }
    }
  }));
}
for (const coin of COINS) {
  const out = `${dir}/e43/${coin}-oi.json`;
  if (existsSync(out)) continue;
  const rows: number[][] = [];
  let done = 0;
  await pool(days, 16, async (d) => {
    const csv = await fetchArchive(`daily/metrics/${coin}USDT/${coin}USDT-metrics-${d}.zip`, 30_000);
    if (++done % 300 === 0) console.log(coin, done, "/", days.length);
    if (!csv) return;
    for (const r of hourlyOpenInterest(csv)) rows.push([r.t, r.oi]);
  });
  rows.sort((a, b) => a[0] - b[0]);
  writeFileSync(out, JSON.stringify(rows));
  console.log(coin, "oi hours", rows.length, rows.length ? new Date(rows[0][0] * 1000).toISOString() : "");
}
