import { test } from "node:test";
import assert from "node:assert/strict";

import { computeTd } from "../src/lib/ta/td.ts";
import { forbiddenPhrase, tdBrief, tdDetailOf, type TdDetail, type TdStat } from "../src/lib/tdbrief.ts";
import type { Candle } from "../src/lib/types.ts";

const base: TdDetail = {
  setupSide: null,
  setupCount: 0,
  setupLength: 9,
  countdownLength: 13,
  countdown: null,
  last: null,
  nextCloseNeeded: null,
  tdstResistance: null,
  tdstSupport: null,
  nine: null,
  timeline: [],
};

test("tdBrief: 12/13 countdown reads as 'went on long', with the cancel level and next-close condition", () => {
  const d1: TdDetail = { ...base, setupSide: "sell", setupCount: 3, nextCloseNeeded: 81938.4, countdown: { side: "sell", count: 12 }, tdstSupport: 62751.1, nine: { side: "sell", barsAgo: 58, perfected: true, countdown: 12, thirteen: null } };
  const b = tdBrief([{ tf: "1d", d: d1 }], "1d", null, []);
  assert.match(b.conclusion, /涨势 13 已数到 12\/13/);
  assert.match(b.conclusion, /不是卖点/);
  assert.ok(b.watch.some((w) => w.includes("还差 1 根") && w.includes("TDST 62,751.1")));
  assert.ok(b.watch.some((w) => w.includes("高于 81,938.4")));
  assert.equal(b.alignment, null);
  assert.match(b.research, /不预测方向/);
});

test("tdBrief: failed 13 on another timeframe shows up in the review; mixed sides are called out", () => {
  const m5: TdDetail = { ...base, setupSide: "buy", setupCount: 1, nine: { side: "buy", barsAgo: 60, perfected: true, countdown: null, thirteen: { barsAgo: 24, riskLevel: 82513.5, invalidated: true, roomPct: -1 } } };
  const h4: TdDetail = { ...base, setupSide: "buy", setupCount: 1, nine: { side: "sell", barsAgo: 1, perfected: true, countdown: 0, thirteen: null } };
  const m15: TdDetail = { ...base, setupSide: "buy", setupCount: 3, nine: { side: "buy", barsAgo: 28, perfected: false, countdown: 11, thirteen: null } };
  const b = tdBrief(
    [
      { tf: "5m", d: m5 },
      { tf: "15m", d: m15 },
      { tf: "4h", d: h4 },
    ],
    "4h",
    { side: "sell", kind: "setup9", barsAgo: 1, price: 82500, riskLevel: 84000, invalidated: false, changePct: -0.2 },
    [],
  );
  assert.match(b.conclusion, /4小时刚出现涨势 9★/);
  assert.ok(b.review.some((r) => r.includes("5分钟的跌势 13 失败了")));
  assert.ok(b.review[0].includes("风险位 84,000 还没被收盘越过"));
  assert.match(b.alignment ?? "", /不一致/);
  assert.equal(b.timeframes.length, 3);
});

test("tdBrief: research sentence only claims what the labels say", () => {
  const stats: TdStat[] = [
    { key: "td_sell13", name: "TD 涨势 13", samples: 40, winRate: 48, baseWinRate: 47, reliability: "证据弱" },
    { key: "td_buy9", name: "TD 跌势 9", samples: 0, winRate: null, baseWinRate: 50, reliability: "证据不足" },
    { key: "rsi_ob", name: "RSI", samples: 50, winRate: 60, baseWinRate: 47, reliability: "证据较强" },
  ];
  const r = tdBrief([{ tf: "4h", d: base }], "4h", null, stats).research;
  assert.match(r, /TD 涨势 13 48%（随机 47%，证据弱）/);
  assert.match(r, /没有一个可靠地好于随机/);
  assert.doesNotMatch(r, /RSI|跌势 9/);
});

test("forbiddenPhrase catches price calls but lets negations and descriptions through", () => {
  assert.equal(forbiddenPhrase("预计会冲上 88000"), "会冲上");
  assert.ok(forbiddenPhrase("大级别一旦跟上就是更大一级的反转"));
  assert.ok(forbiddenPhrase("即将迎来反弹"));
  assert.ok(forbiddenPhrase("叠加头肩底，会拉一大波"));
  assert.equal(forbiddenPhrase("它说明走了很久，不说明马上反转"), null);
  assert.equal(forbiddenPhrase("收盘跌破 TDST 会取消这次计数"), null);
  assert.equal(forbiddenPhrase("13 已出现但失败了（收盘突破风险位 85,221）"), null);
});

test("tdDetailOf matches the engine on a synthetic run (9 then a running countdown)", () => {
  const c: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 40; i++) {
    p += i < 5 ? -1 : 1;
    c.push({ t: i * 3600, o: p - 0.5, h: p + 0.5, l: p - 1, c: p, v: 1 });
  }
  const td = computeTd(c);
  const d = tdDetailOf(td, c);
  assert.equal(d.nine?.side, "sell");
  assert.equal(d.setupSide, "sell");
  assert.ok(d.nine && (d.nine.countdown != null || d.nine.thirteen != null));
  const nine = d.timeline.find((x) => x.kind === 9)!;
  assert.ok(["counting", "reached13"].includes(nine.status));
  assert.ok(nine.upPct > 0 && nine.downPct <= 0);
});

test("AI answers wrapped in a code fence or reshaped by a proxy are still read", async () => {
  process.env.LOG_LEVEL = "error";
  const { parseLooseJson, normalizeTd, normalizeOverview } = await import("../src/lib/server/ai.ts");
  const fenced = '```json\n{\n  "conclusion": "4小时8小时前出了卖出9★",\n  "timeframes": [\n    {"tf": "15分钟", "text": "买入9★之后13数到4/13"},\n    {"tf": "1小时", "text": "13数到3/13"}\n  ],\n  "review": ["上一个卖出 9 之后 -2.2%"],\n  "watch": "下一根收盘低于 82,459.2 才继续"\n}\n```';
  const td = normalizeTd(parseLooseJson(fenced));
  assert.equal(td.conclusion, "4小时8小时前出了卖出9★");
  assert.equal(td.timeframes, "15分钟：买入9★之后13数到4/13\n1小时：13数到3/13");
  assert.equal(td.review, "上一个卖出 9 之后 -2.2%");
  assert.deepEqual(td.watch, ["下一根收盘低于 82,459.2 才继续"]);
  const ov = normalizeOverview(parseLooseJson('好的，解读如下：{"headline":"偏空","summary":"s","timeframes":"t","levels":"l","watch":["w"],"invalidation":"i","caution":"c"} 以上。'));
  assert.equal(ov.headline, "偏空");
  assert.throws(() => normalizeTd(parseLooseJson('{"conclusion":""}')));
  assert.throws(() => parseLooseJson("没有 JSON"));
});

test("classic cancellation reproduces another site's countdown marks on the same 499 daily bars; the default rule differs in 4", async () => {
  const { readFileSync } = await import("node:fs");
  const f = JSON.parse(readFileSync(new URL("./fixtures/td-btc-1d.json", import.meta.url), "utf8")) as {
    candles: [number, number, number, number, number][];
    countdown: [number, "buy" | "sell", number][];
    nines: [number, "buy" | "sell"][];
    risk13: number;
  };
  const c: Candle[] = f.candles.map(([t, o, h, l, cl]) => ({ t, o, h, l, c: cl, v: 0 }));
  const marks = (classicCancel: boolean) => {
    const td = computeTd(c, { setupLength: 9, setupLookback: 4, countdownLength: 13, countdownLookback: 2, classicCancel });
    const out = new Map<string, number>();
    c.forEach((x, i) => {
      if (td.buyCountdown[i]) out.set(`${x.t}|buy`, td.buyCountdown[i]);
      if (td.sellCountdown[i]) out.set(`${x.t}|sell`, td.sellCountdown[i]);
    });
    return { td, out };
  };
  const want = new Map(f.countdown.map(([t, s, n]) => [`${t}|${s}`, n]));
  const diff = (got: Map<string, number>) => [...new Set([...want.keys(), ...got.keys()])].filter((k) => want.get(k) !== got.get(k)).length;
  const classic = marks(true);
  assert.equal(diff(classic.out), 0);
  assert.equal(diff(marks(false).out), 4);
  assert.deepEqual(
    classic.td.events.filter((e) => e.kind === "setup9").map((e) => [e.t, e.side]),
    f.nines,
  );
  const thirteens = classic.td.events.filter((e) => e.kind === "countdown13");
  assert.equal(thirteens.length, 1);
  assert.equal(Math.round(thirteens[0].riskLevel * 10) / 10, f.risk13);
});

test("a fresh 13 meeting a larger timeframe's running count quotes E25 instead of calling it a relay", () => {
  const m15: TdDetail = { ...base, nine: { side: "buy", barsAgo: 5, perfected: true, countdown: null, thirteen: { barsAgo: 2, riskLevel: 81000, invalidated: false, roomPct: 0.8 } } };
  const h1: TdDetail = { ...base, countdown: { side: "buy", count: 11 }, nine: { side: "buy", barsAgo: 20, perfected: true, countdown: 11, thirteen: null } };
  const b = tdBrief([{ tf: "15m", d: m15 }, { tf: "1h", d: h1 }], "15m", null, []);
  assert.match(b.alignment ?? "", /1小时的跌势 13 还在数（11\/13）/);
  assert.match(b.alignment ?? "", /比随机差/);
  assert.equal(forbiddenPhrase(b.alignment ?? ""), null);
});
