// Download Binance spot history for BTC/ETH (full 1d/4h, last 20,000 1h bars) into <dir>/<COIN>_<tf>.json.
//   node research/fetch.mjs research/hist            all six datasets
//   node research/fetch.mjs research/hist BTC_4h     only the ones named
import fs from "node:fs";
const out = process.argv[2], only = process.argv.slice(3);
fs.mkdirSync(out, { recursive: true });
for (const coin of ["BTC", "ETH"]) for (const tf of ["1d", "4h", "1h"]) {
  if (only.length && !only.includes(`${coin}_${tf}`)) continue;
  let end = "", rows = [];
  for (;;) {
    const u = `https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=${tf}&limit=1000${end ? `&endTime=${end}` : ""}`;
    const r = await (await fetch(u)).json();
    if (!r.length) break;
    rows = r.concat(rows);
    if (r.length < 1000) break;
    end = String(r[0][0] - 1);
    if (tf === "1h" && rows.length >= 20000) break;
  }
  const c = rows.map((r) => ({ t: r[0] / 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  fs.writeFileSync(`${out}/${coin}_${tf}.json`, JSON.stringify(c));
  console.log(coin, tf, c.length, new Date(c[0].t * 1000).toISOString().slice(0, 10), "→", new Date(c.at(-1).t * 1000).toISOString().slice(0, 16));
}
