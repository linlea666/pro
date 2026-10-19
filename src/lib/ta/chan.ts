import type { Candle } from "../types.ts";
import * as ta from "./core.ts";

/**
 * 缠论 (Chan theory), simplified:
 * 包含处理 → 分型 → 笔 → 中枢 → 一/二/三类买卖点.
 * Divergence for 一买/一卖 compares MACD histogram area of the two legs.
 */

interface Merged {
  h: number;
  l: number;
  /** raw index holding the extreme used by the fractal */
  hiRaw: number;
  loRaw: number;
}

export interface Bi {
  from: { i: number; t: number; price: number };
  to: { i: number; t: number; price: number };
  dir: "up" | "down";
}

export interface Zhongshu {
  start: number;
  end: number;
  tStart: number;
  tEnd: number;
  zg: number;
  zd: number;
}

export interface ChanPoint {
  i: number;
  t: number;
  price: number;
  type: "1买" | "2买" | "3买" | "1卖" | "2卖" | "3卖";
}

export interface ChanResult {
  bis: Bi[];
  zhongshus: Zhongshu[];
  points: ChanPoint[];
  explain: string;
}

function mergeInclusive(c: Candle[]): Merged[] {
  const out: Merged[] = [];
  for (let i = 0; i < c.length; i++) {
    const cur: Merged = { h: c[i].h, l: c[i].l, hiRaw: i, loRaw: i };
    const prev = out[out.length - 1];
    if (prev && ((prev.h >= cur.h && prev.l <= cur.l) || (cur.h >= prev.h && cur.l <= prev.l))) {
      const before = out[out.length - 2];
      const up = before ? prev.h > before.h : true;
      if (up) {
        if (cur.h >= prev.h) prev.hiRaw = cur.hiRaw;
        if (cur.l >= prev.l) prev.loRaw = cur.loRaw;
        prev.h = Math.max(prev.h, cur.h);
        prev.l = Math.max(prev.l, cur.l);
      } else {
        if (cur.h <= prev.h) prev.hiRaw = cur.hiRaw;
        if (cur.l <= prev.l) prev.loRaw = cur.loRaw;
        prev.h = Math.min(prev.h, cur.h);
        prev.l = Math.min(prev.l, cur.l);
      }
      continue;
    }
    out.push(cur);
  }
  return out;
}

export function computeChan(c: Candle[]): ChanResult {
  const m = mergeInclusive(c);
  // fractals on merged bars
  type F = { k: number; kind: "top" | "bottom"; price: number; raw: number };
  const fr: F[] = [];
  for (let k = 1; k < m.length - 1; k++) {
    if (m[k].h > m[k - 1].h && m[k].h > m[k + 1].h) fr.push({ k, kind: "top", price: m[k].h, raw: m[k].hiRaw });
    else if (m[k].l < m[k - 1].l && m[k].l < m[k + 1].l) fr.push({ k, kind: "bottom", price: m[k].l, raw: m[k].loRaw });
  }
  // strokes: alternate top/bottom, at least 4 merged bars apart
  const pts: F[] = [];
  for (const f of fr) {
    const last = pts[pts.length - 1];
    if (!last) {
      pts.push(f);
      continue;
    }
    if (f.kind === last.kind) {
      if ((f.kind === "top" && f.price > last.price) || (f.kind === "bottom" && f.price < last.price)) pts[pts.length - 1] = f;
      continue;
    }
    const valid = f.k - last.k >= 4 && (f.kind === "top" ? f.price > last.price : f.price < last.price);
    if (valid) pts.push(f);
  }
  const bis: Bi[] = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    bis.push({
      from: { i: a.raw, t: c[a.raw].t, price: a.price },
      to: { i: b.raw, t: c[b.raw].t, price: b.price },
      dir: b.kind === "top" ? "up" : "down",
    });
  }

  // 中枢: three consecutive strokes overlapping
  const zs: (Zhongshu & { firstBi: number; lastBi: number })[] = [];
  let k = 0;
  while (k + 2 < bis.length) {
    const seg = bis.slice(k, k + 3);
    const zg = Math.min(...seg.map(biHigh));
    const zd = Math.max(...seg.map(biLow));
    if (zg > zd) {
      let end = k + 2;
      while (end + 1 < bis.length && biLow(bis[end + 1]) < zg && biHigh(bis[end + 1]) > zd) end++;
      zs.push({ start: bis[k].from.i, end: bis[end].to.i, tStart: bis[k].from.t, tEnd: bis[end].to.t, zg, zd, firstBi: k, lastBi: end });
      k = end + 1;
    } else k++;
  }

  // buy/sell points
  const hist = ta.macd(ta.closes(c)).hist;
  const area = (b: Bi) => {
    let s = 0;
    for (let i = b.from.i; i <= b.to.i; i++) if (!Number.isNaN(hist[i])) s += Math.abs(hist[i]);
    return s;
  };
  const points: ChanPoint[] = [];
  const add = (b: Bi, type: ChanPoint["type"]) => points.push({ i: b.to.i, t: b.to.t, price: b.to.price, type });

  const hi = biHigh, lo = biLow;
  const used = new Set<string>();
  for (let k = 0; k < bis.length; k++) {
    // most recent pivot that was fully formed before this stroke
    const z = [...zs].reverse().find((x) => x.firstBi + 2 < k);
    if (!z) continue;
    const b = bis[k];
    const prev = bis[k - 1];
    // 三买/三卖: the previous stroke broke out of the pivot, this pullback stays outside it
    if (b.dir === "down" && prev && prev.to.price > z.zg && prev.from.price <= z.zg && b.to.price > z.zg) add(b, "3买");
    if (b.dir === "up" && prev && prev.to.price < z.zd && prev.from.price >= z.zd && b.to.price < z.zd) add(b, "3卖");
    // 一买/一卖: new extreme beyond the pivot with weaker MACD area than the stroke that entered it
    const enterDown = [bis[z.firstBi - 1], bis[z.firstBi - 2]].find((x) => x?.dir === "down");
    const enterUp = [bis[z.firstBi - 1], bis[z.firstBi - 2]].find((x) => x?.dir === "up");
    const minZ = Math.min(...bis.slice(z.firstBi, z.lastBi + 1).map(lo));
    const maxZ = Math.max(...bis.slice(z.firstBi, z.lastBi + 1).map(hi));
    if (b.dir === "down" && enterDown && !used.has(`b${z.start}`) && b.to.price < Math.min(minZ, enterDown.to.price) && area(b) < area(enterDown)) {
      used.add(`b${z.start}`);
      add(b, "1买");
      const next = bis[k + 2];
      if (next && next.dir === "down" && next.to.price > b.to.price) add(next, "2买");
    }
    if (b.dir === "up" && enterUp && !used.has(`s${z.start}`) && b.to.price > Math.max(maxZ, enterUp.to.price) && area(b) < area(enterUp)) {
      used.add(`s${z.start}`);
      add(b, "1卖");
      const next = bis[k + 2];
      if (next && next.dir === "up" && next.to.price < b.to.price) add(next, "2卖");
    }
  }
  points.sort((a, b) => a.i - b.i);

  const lastZ = zs[zs.length - 1];
  const lastP = points[points.length - 1];
  const price = c[c.length - 1].c;
  let explain = `识别出 ${bis.length} 笔、${zs.length} 个中枢。`;
  if (lastZ) {
    explain +=
      price > lastZ.zg
        ? `价格在最近中枢（${fmt(lastZ.zd)}–${fmt(lastZ.zg)}）上方，结构偏强。`
        : price < lastZ.zd
          ? `价格在最近中枢（${fmt(lastZ.zd)}–${fmt(lastZ.zg)}）下方，结构偏弱。`
          : `价格在最近中枢（${fmt(lastZ.zd)}–${fmt(lastZ.zg)}）内部来回震荡。`;
  }
  if (lastP) explain += `最近一个买卖点是「${lastP.type}」。`;
  return { bis, zhongshus: zs.map(({ firstBi: _a, lastBi: _b, ...z }) => z), points, explain };
}

const biHigh = (b: Bi) => Math.max(b.from.price, b.to.price);
const biLow = (b: Bi) => Math.min(b.from.price, b.to.price);
const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v.toPrecision(4));
