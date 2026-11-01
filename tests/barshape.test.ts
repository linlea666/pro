import { test } from "node:test";
import assert from "node:assert/strict";
import { barShape, barShapeText, WICK_FACT } from "../src/lib/ta/barshape.ts";
import { forbiddenPhrase } from "../src/lib/tdbrief.ts";
import type { Candle } from "../src/lib/types.ts";

const bar = (t: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ t, o, h, l, c, v }) as Candle;

test("barShape: long lower wick with expanding volume", () => {
  const c: Candle[] = [];
  for (let i = 0; i < 20; i++) c.push(bar(i * 900, 100, 101, 99, 100.5, 10));
  c.push(bar(20 * 900, 100, 100.6, 96, 100.4, 20)); // lower wick 4/4.6
  const s = barShape(c, 20)!;
  assert.equal(s.longWick, "lower");
  assert.equal(s.vol, "up");
  assert.equal(s.volX, 2);
  assert.ok(s.lowerPct > 80);
  assert.match(barShapeText(s), /长下影.*放量 2 倍/);
});

test("barShape: long upper wick with shrinking volume, and a plain bar", () => {
  const c: Candle[] = [];
  for (let i = 0; i < 20; i++) c.push(bar(i * 900, 100, 101, 99, 100.5, 10));
  c.push(bar(20 * 900, 100, 104, 99.8, 99.9, 5));
  assert.equal(barShape(c, 20)!.longWick, "upper");
  assert.equal(barShape(c, 20)!.vol, "down");
  c.push(bar(21 * 900, 99.2, 101, 99, 100.8, 10));
  const p = barShape(c, 21)!;
  assert.equal(p.longWick, null);
  assert.equal(p.vol, "normal");
  assert.match(barShapeText(p), /没有长影线/);
  assert.equal(barShape(c, 99), null);
});

test("WICK_FACT has no forecast wording", () => {
  assert.equal(forbiddenPhrase(WICK_FACT), null);
});
