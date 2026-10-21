import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-pa-"));
process.env.LOG_LEVEL = "error";
const { classifyLocation, nearbyLevels, paResearchOf, patternSentence, pickConfirm, rulesMatch, trendSentence } = await import("../src/lib/pa.ts");
const { PA_RULES, PATTERNS } = await import("../src/lib/ta/patterns.ts");
type PaSetupView = import("../src/lib/pa.ts").PaSetupView;
type ResearchRow = import("../src/lib/research/run.ts").ResearchRow;
type ResearchReport = import("../src/lib/research/run.ts").ResearchReport;
type Group = import("../src/lib/research/engine.ts").Group;

const lv = (price: number, name = "4 小时摆动低点") => ({ price, kind: "pivot" as const, name });

test("levels: nearest first on each side, one level within 0.25 ATR, three a side, lowest first", () => {
  const close = 100, atr = 2;
  const all = [lv(99), lv(98.7), lv(97), lv(95), lv(90), lv(101), lv(101.4), lv(103), lv(110), lv(120)];
  const rows = nearbyLevels(all, close, atr);
  assert.deepEqual(
    rows.map((x) => x.price),
    [95, 97, 99, 101, 103, 110],
    "98.7 merges into 99 (0.15 ATR), 101.4 into 101 (0.2 ATR); three a side",
  );
  assert.deepEqual(rows.map((x) => x.side), ["support", "support", "support", "resistance", "resistance", "resistance"]);
  assert.equal(rows[2].distAtr, -0.5);
  assert.equal(rows[3].distAtr, 0.5);
  assert.deepEqual(nearbyLevels(all, close, NaN), [], "no ATR, no levels");
});

test("location: within keyAtr × ATR of a support or a resistance, the nearer wins, else the middle", () => {
  const atr = 2, k = PA_RULES.keyAtr * atr;
  const sup = nearbyLevels([lv(100 - k + 0.01, "前一日低点"), lv(110, "上周高点")], 100, atr);
  const a = classifyLocation(sup, 100, atr);
  assert.equal(a.loc, "support");
  assert.equal(a.level?.name, "前一日低点");
  assert.match(a.sentence, /^在支撑区/);

  const both = nearbyLevels([lv(99.5), lv(100.3, "上周高点")], 100, atr);
  assert.equal(classifyLocation(both, 100, atr).loc, "resistance", "0.15 ATR above beats 0.25 ATR below");

  const far = nearbyLevels([lv(100 - k - 0.01), lv(100 + k + 0.01)], 100, atr);
  const m = classifyLocation(far, 100, atr);
  assert.equal(m.loc, "mid");
  assert.equal(m.level, null);
  assert.match(m.sentence, /中间位置不做/);
  assert.equal(classifyLocation([], 100, atr).loc, "mid");
});

const setup = (o: Partial<PaSetupView>): PaSetupView => ({
  kind: "pin",
  name: "长影线",
  dir: 1,
  status: "entered",
  trigger: 101,
  entry: 101.5,
  extreme: 99,
  stop: 98.2,
  riskAtr: 1.6,
  ok: true,
  trend: "with",
  loc: "key",
  startT: 1000,
  sT: 1000,
  eT: 2000,
  barsAgo: 0,
  stopped: false,
  ...o,
});

test("step 3: key-level setups entered on the last three closed bars (newest first), then the waiting ones", () => {
  const list = [
    setup({ kind: "engulf", barsAgo: 2, eT: 3000 }),
    setup({ kind: "inside", barsAgo: 1, eT: 3500, stopped: true }),
    setup({ kind: "pin", barsAgo: 3, eT: 2000 }),
    setup({ kind: "inside", barsAgo: 0, eT: 5000, loc: "mid" }),
    setup({ kind: "fake2b", barsAgo: 1, eT: 4000 }),
    setup({ kind: "retest", status: "waiting", entry: null, eT: null, barsAgo: null, sT: 6000 }),
    setup({ kind: "pin", status: "waiting", entry: null, eT: null, barsAgo: null, sT: 6000, loc: "mid" }),
  ];
  const got = pickConfirm(list)!;
  assert.deepEqual(
    got.map((x) => x.kind),
    ["fake2b", "engulf", "retest"],
    "three bars ago is too old; the middle does not count",
  );
  assert.equal(pickConfirm([setup({ barsAgo: 3 }), setup({ loc: "mid" })]), null, "nothing: wait");
  assert.equal(pickConfirm([]), null);
});

test("trend: one plain sentence from the structure", () => {
  assert.equal(trendSentence("4h", "up", "none", "上升趋势"), "4 小时上升：更高的高点和更高的低点");
  assert.equal(trendSentence("1d", "down", "none", "下降趋势"), "日线下降：更低的高点和更低的低点");
  assert.match(trendSentence("4h", "up", "broken", "上升结构被破坏（转折中）"), /跌破保护低点/);
  assert.equal(trendSentence("1h", "range", "none", "区间 / 转折中"), "1 小时区间（没有明确方向）：高低点方向不一致");
  assert.equal(trendSentence("15m", "range", "none", "上升结构被打破（转向下跌中）"), "15 分钟区间：上升结构被打破（转向下跌中）");
});

// ---------------------------------------------------------------- research

const group = (n: number, edgeR: number | null, meanR: number | null = edgeR): Group => ({ n, hit: 40, hitLo: null, hitHi: null, baseHit: null, meanPct: null, meanR, edgeR, p: null });
const row = (key: string, verdict: ResearchRow["verdict"], edgeR = 0.05, n = 200): ResearchRow => ({
  family: "pa",
  key,
  name: key,
  side: "bull",
  tf: "4h",
  horizon: 180,
  cells: { is: group(n, edgeR), oos: group(40, -0.1), btc: group(100, 0), eth: group(100, 0), firstHalf: group(100, 0), secondHalf: group(100, 0) },
  q: 0.8,
  consistent: false,
  verdict,
  extra: { reach2: 31.5, quickStopPct: 17, setups: 900, triggerPct: 55 },
});
const report = (rows: ResearchRow[], rules: Record<string, number> | undefined = { ...PA_RULES }): ResearchReport & { id: number } => ({
  id: 7,
  kind: "patterns",
  title: "E20",
  createdAt: 1,
  source: "binance-futures",
  paramsVersion: 0,
  costPct: 0.15,
  alpha: 0.05,
  holdoutFrom: 0,
  coins: ["BTC", "ETH"],
  coverage: [],
  rows,
  notes: [],
  durationMs: 1,
  rules,
});

test("research: numbers only for the timeframes researched, with the current rules", () => {
  const rows = PATTERNS.flatMap((k) => [row(`pa:4h:${k}:all`, "无可证明的优势"), row(`pa:4h:${k}:text`, "无可证明的优势")]);
  for (const pf of ["15m", "1h"] as const) assert.deepEqual(paResearchOf(report(rows), pf), { view: null, note: "这个周期还没有研究数字。" });
  assert.match(paResearchOf(null, "4h").note!, /服务器生成研究报告后显示/);
  assert.equal(paResearchOf(report(rows, { ...PA_RULES, keyAtr: 0.6 }), "4h").note, "研究规则已更新，等新的研究报告。");
  const bare = report(rows);
  delete bare.rules;
  assert.equal(paResearchOf(bare, "4h").view, null, "a report without rules is not trusted");
  const { pinWick: _, ...fewer } = PA_RULES;
  assert.equal(rulesMatch(fewer), false, "a missing rule counts as a difference");
  assert.equal(rulesMatch(JSON.parse(JSON.stringify(PA_RULES))), true, "stored as JSON, still the same");

  const r = paResearchOf(report(rows), "4h");
  assert.equal(r.note, null);
  assert.equal(r.view!.items.length, 5);
  const pin = r.view!.items[0];
  assert.equal(pin.kind, "pin");
  assert.equal(pin.all!.n, 200);
  assert.equal(pin.reach2, 31.5);
  assert.equal(pin.quickStopPct, 17);
  assert.equal(pin.textName, "关键位 + 顺势");
  assert.equal(r.view!.items[3].textName, "顺势");
  assert.equal(pin.sentence, "历史上和同止损距离的随机入场差不多，没有可证明的优势；在关键位、顺势时也一样。");
  // the daily rows are not in this report
  assert.match(paResearchOf(report(rows), "1d").note!, /还没有这个周期/);
});

test("research sentences follow the verdicts and never claim more", () => {
  assert.equal(patternSentence("engulf", row("a", "无可证明的优势"), row("t", "样本不足", 0.3, 12)), "历史上和同止损距离的随机入场差不多，没有可证明的优势；在关键位、顺势时的样本太少，还不能下结论。");
  assert.equal(patternSentence("fake2b", row("a", "样本不足", 0, 5), undefined), "样本太少，还不能下结论。");
  assert.match(patternSentence("retest", row("a", "比随机差", -0.3), row("t", "无可证明的优势")), /^历史上平均每笔比同止损距离的随机入场差 0\.30R，统计上站得住；顺势时：历史上和同止损距离的随机入场差不多/);
  assert.match(patternSentence("pin", row("a", "有优势", 0.25), row("t", "有优势", 0.4)), /好 0\.25R，达到了研究标准（不保证下一次）；在关键位、顺势时也一样/);
  for (const v of ["无可证明的优势", "样本不足", "比随机差"] as const) assert.doesNotMatch(patternSentence("inside", row("a", v), row("t", v)), /有效|管用|胜率高/);
});
