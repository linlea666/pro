import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { atrSeries } from "../src/lib/ta/risk.ts";
import { describeStructure, structureSeries, swings } from "../src/lib/ta/structure.ts";

/** Candles that walk a path of closes one unit per bar, with small wicks. */
function path(points: number[]): Candle[] {
  const out: Candle[] = [];
  let p = points[0];
  for (let k = 1; k < points.length; k++) {
    const step = Math.sign(points[k] - p);
    while (p !== points[k]) {
      const o = p;
      p += step;
      out.push({ t: out.length * 3600, o, c: p, h: Math.max(o, p) + 0.3, l: Math.min(o, p) - 0.3, v: 1 });
    }
  }
  return out;
}

test("structure: higher highs and higher lows read as an uptrend, protected by the last higher low", () => {
  const c = path([100, 110, 105, 115, 109, 121, 118]);
  const atr = atrSeries(c);
  const sw = swings(c, atr);
  assert.deepEqual(
    sw.map((s) => `${s.kind === "high" ? "H" : "L"}${Math.round(s.price)}${s.label ?? ""}`),
    ["L100", "H110", "L105HL", "H115HH", "L109HL", "H121HH"],
  );
  const series = structureSeries(c, atr);
  const last = series[c.length - 1];
  assert.equal(last.state, "up");
  assert.equal(last.breach, "none");
  assert.equal(Math.round(last.protective!.price), 109);
  assert.equal(last.legs, 2, "110 → 115 → 121: two higher highs in a row");
  const v = describeStructure(c, atr, series, sw);
  assert.equal(v.label, "上升趋势");
  assert.ok(v.retracement! > 0 && v.retracement! < 0.5, "pulled back a little from 121");
});

test("structure: only closes count; 0.1 ATR beyond the protective low is pierced, 0.8 ATR is broken", () => {
  const up = path([100, 110, 105, 115, 109, 121]);
  const atr0 = atrSeries(up);
  const a = atr0[atr0.length - 1];
  // a long wick far below 109 that closes back above it changes nothing
  const wick = [...up, { t: up.length * 3600, o: 121, h: 121.3, l: 100, c: 120, v: 1 }];
  const sWick = structureSeries(wick, atrSeries(wick));
  assert.equal(sWick[wick.length - 1].breach, "none");
  // walk down: first a close just under 109 (pierced), then one well below (broken)
  const down = path([100, 110, 105, 115, 109, 121, 109]);
  const pierce = [...down, { t: down.length * 3600, o: 109, h: 109.2, l: 108.5, c: 109 - 0.3 * a, v: 1 }];
  const sp = structureSeries(pierce, atrSeries(pierce));
  assert.equal(sp[pierce.length - 1].breach, "pierced");
  // a close 0.8 ATR under the protective low breaks the structure...
  const brk = [...pierce, { t: pierce.length * 3600, o: 108.6, h: 108.7, l: 107.2, c: 108.7 - 0.9 * a, v: 1 }];
  const sb = structureSeries(brk, atrSeries(brk));
  assert.equal(sb[brk.length - 1].breach, "broken");
  // ...and it stays broken when price closes back above it without a new swing low (bounce < 2 ATR)
  const back = [...brk, { t: brk.length * 3600, o: 107.4, h: 109.6, l: 107.3, c: 109.5, v: 1 }];
  const sk = structureSeries(back, atrSeries(back))[back.length - 1];
  assert.equal(sk.state, "up");
  assert.equal(sk.breach, "broken");
  // a deep break followed by a big bounce confirms a lower low: highs up, lows down = range / turning
  const deep = [...pierce, { t: pierce.length * 3600, o: 108.6, h: 108.7, l: 104, c: 104.5, v: 1 }, { t: (pierce.length + 1) * 3600, o: 104.5, h: 110, l: 104.4, c: 109.8, v: 1 }];
  assert.equal(structureSeries(deep, atrSeries(deep))[deep.length - 1].state, "range");
});

test("structure: a single wide bar never makes a high and a low at once", () => {
  const c = path([100, 90, 95, 88]);
  c.push({ t: c.length * 3600, o: 88, l: 80, h: 100, c: 99, v: 1 });
  const more = path([99, 92, 97]).map((x, k) => ({ ...x, t: (c.length + k) * 3600 }));
  const all = [...c, ...more];
  const sw = swings(all, atrSeries(all));
  for (let k = 1; k < sw.length; k++) assert.notEqual(sw[k].i, sw[k - 1].i, "two swings on one bar");
  for (let k = 1; k < sw.length; k++) assert.notEqual(sw[k].kind, sw[k - 1].kind, "highs and lows alternate");
});

test("structure: what is known at a bar never changes when later bars arrive", () => {
  let s = 7;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let p = 100;
  const c: Candle[] = Array.from({ length: 600 }, (_, i) => {
    const o = p;
    p *= 1 + (r() - 0.5) * 0.03;
    return { t: i * 3600, o, c: p, h: Math.max(o, p) * (1 + r() * 0.004), l: Math.min(o, p) * (1 - r() * 0.004), v: 1 };
  });
  const full = structureSeries(c, atrSeries(c));
  const key = (x: (typeof full)[number]) =>
    JSON.stringify([x.state, x.breach, x.protective?.i, x.lastHigh?.i, x.lastLow?.i, x.legs, x.since, x.beyond]);
  for (const t of [120, 250, 333, 480, 599]) {
    const part = c.slice(0, t + 1);
    assert.equal(key(structureSeries(part, atrSeries(part))[t]), key(full[t]), `bar ${t}`);
  }
});
