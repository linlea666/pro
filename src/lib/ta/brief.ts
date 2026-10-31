import type { Candle } from "../types.ts";
import type { BigTrend, TfTrend } from "./bigtrend.ts";
import { PHASE_FACTS, PHASE_NAMES, phaseAt, type Phase, type PhaseDir } from "./phase.ts";
import { DEFAULT_SWING_ATR, type StructureState } from "./structure.ts";

/**
 * 行情导视（2026-10-31，借鉴竞品“行情导视”长图的版式）：币页总览顶部的一张卡，把已有模块的结果拼成一页——
 * 一句话（日线结构 + 4 小时行情阶段）、几个关键数字（这段低点 / 转强线 / 再往外最近的关键位 / 日线失效价）、
 * 各周期一格（1 小时、4 小时、日线、周线的阶段）、“接下来看什么”（哪个周期收在哪 → 页面状态会变成什么，附 E33b 的历史比例）。
 *
 * 不加任何新规则：阶段用 `phaseAt`（同盯盘的阶段卡），日线 / 周线用大趋势卡的 `TfTrend`，关键位用计划页同一套融合关键位。
 * 只描述：不叫“多空分界”，不说“先看 / 会去”，不放指标偏强偏弱的汇总（E35 / E36 / E38 都没有方向优势）。
 */

export type BriefTone = "up" | "down" | "neutral";

export interface BriefLevelIn {
  price: number;
  /** 前几种方法的名字和方法总数、周期（大到小），同 `TrendPlan.levels` */
  methods: string[];
  methodCount: number;
  tfs: string[];
}

export interface BriefNumber {
  key: "core" | "turn" | "next" | "near" | "flip";
  label: string;
  price: number;
  note: string;
  /** above / below the live price, or the daily line */
  side: "above" | "below" | "flip";
}

export interface BriefCell {
  tf: "1h" | "4h" | "1d" | "1w";
  name: string;
  tone: BriefTone;
  text: string;
}

export interface BriefNext {
  when: string;
  then: string;
  /** BTC / ETH 4 小时历史上的比例（E33b），没有为 null */
  fact: string | null;
  tone: BriefTone;
}

export interface MarketBrief {
  /** 4 小时最后一根已收盘 K 线的开盘时刻（北京时间显示由页面做） */
  t: number;
  title: string;
  line: string;
  /** 价格从高到低 */
  numbers: BriefNumber[];
  /** 4 小时这段低点到反弹高点（止跌尝试 / 反弹时），图上画浅色带 */
  band: { lo: number; hi: number; label: string } | null;
  cells: BriefCell[];
  next: BriefNext[];
  /** 日线有方向时：哪一边是逆日线、按规则半仓（同大趋势卡） */
  against: string | null;
  foot: string;
}

export interface BriefInput {
  /** 现价（实时为正在走的那根的最新价，回放为最后收盘） */
  price: number;
  h4: { c: Candle[]; atr: number[]; ss: StructureState[] };
  h1: { c: Candle[]; atr: number[]; ss: StructureState[] } | null;
  big: BigTrend | null;
  /** 现价下方 / 上方的关键位，离现价近的在前 */
  supports: BriefLevelIn[];
  resistances: BriefLevelIn[];
  mult?: number;
}

export const BRIEF_FOOT =
  "这张卡只描述现在在哪、接下来看哪根收盘，不预测涨跌。比例是 BTC / ETH 4 小时的历史（E33b），不是这一次的概率。要下单：去「实时盯盘」等转强，或看「趋势与计划」的认错位和仓位。";

const fmt = (x: number | null | undefined) => (x == null ? "—" : x >= 1000 ? Math.round(x).toLocaleString("en-US") : x >= 1 ? String(Math.round(x * 100) / 100) : x.toPrecision(4));

const words = (d: PhaseDir) =>
  d > 0
    ? { x: "低", newX: "创新低", up: "站上", down: "跌破", better: "更高的低点", bounce: "反弹高点", go: "继续创新高", fail: "跌破更高的低点", beyondSide: "下方", turnWord: "转强线" }
    : { x: "高", newX: "创新高", up: "跌破", down: "涨破", better: "更低的高点", bounce: "回落低点", go: "继续创新低", fail: "涨破更低的高点", beyondSide: "上方", turnWord: "转弱线" };

/** 阶段格的颜色：按这一格说的方向（下跌中 / 转弱 为跌，上涨中 / 转强 为涨），中间几格中性 */
export function phaseTone(name: string | null): BriefTone {
  if (!name) return "neutral";
  if (name === "下跌中" || name === "转弱") return "down";
  if (name === "上涨中" || name === "转强" || name === "上升中") return "up";
  return "neutral";
}

const source = (l: BriefLevelIn) => {
  if (!l.methods.length) return "";
  const m = l.methods.slice(0, 2).join("、") + (l.methodCount > 2 ? ` 等 ${l.methodCount} 种方法` : "");
  return `来自：${m}${l.tfs.length ? ` · ${l.tfs.join(" / ")}` : ""}`;
};

/** 一个阶段格的一句话（短，手机一格放得下） */
export function phaseCellText(p: Phase): string {
  const w = words(p.dir);
  if (p.stage === 1) return `还在${w.newX}，最${w.x} ${fmt(p.low)}`;
  if (p.stage === 2) return `${fmt(p.low)} 后没再${w.newX}，${w.x}点还没站住`;
  if (p.stage === 4) return `${w.better} ${fmt(p.higherLow)}，已收盘${w.up}${w.bounce}`;
  const need = [!p.checks[2] ? w.better : null, !p.checks[3] ? `收盘${w.up} ${fmt(p.trigger)}` : null].filter(Boolean);
  return `${w.x}点站住了，还差${need.join("、")}`;
}

const DIR_WORD = { 1: "上", [-1]: "下" } as const;

/** 日线 / 周线的结构说法（区间时补上脱离方向） */
const trendLabel = (t: TfTrend) => `${t.label}${t.dir !== 0 && !/上升|下降/.test(t.label) ? `（向${DIR_WORD[t.dir]}脱离中）` : ""}`;

function trendCell(t: TfTrend): BriefCell {
  const up = t.dir < 0; // 下降趋势的失效价在上方
  const tail = t.flipAt != null ? `；收盘${up ? "站上" : "跌破"} ${fmt(t.flipAt)} 才失效` : t.dir === 0 ? "；等走出更高或更低的高低点" : "";
  const name = t.phase ?? (t.dir > 0 ? "向上" : t.dir < 0 ? "向下" : "没有方向");
  const tone: BriefTone = t.phase ? phaseTone(t.phase) : t.dir > 0 ? "up" : t.dir < 0 ? "down" : "neutral";
  return { tf: t.tf, name, tone, text: `${trendLabel(t)}${tail}` };
}

/** E33b 的一个比例：`up` 先走到 ④（④ 时为继续创新高），`back` 先回到 ①（④ 时为转强失败） */
const fact = (p: Phase, which: "up" | "back"): string | null => {
  const f = PHASE_FACTS[`4h:${p.dir}:${p.stage}`];
  if (!f || f.n < 20) return null;
  const names = PHASE_NAMES[p.dir];
  const w = words(p.dir);
  const here = `历史上 4 小时${names[p.stage - 1]}之后`;
  if (p.stage === 4) return which === "up" ? `${here} ${f.up}% 先${w.go}` : `${here} ${f.back}% 先${w.fail}`;
  return which === "up" ? `${here} ${f.up}% 先走到${names[3]}` : `${here} ${f.back}% 先回到${names[0]}`;
};

/** 组装行情导视；4 小时阶段算不出来（数据不够）时为 null。只读到最后一根已收盘 K 线。 */
export function marketBrief(x: BriefInput): MarketBrief | null {
  const mult = x.mult ?? DEFAULT_SWING_ATR;
  const n4 = x.h4.c.length - 1;
  if (n4 < 50) return null;
  const p4 = phaseAt(x.h4.c, x.h4.atr, x.h4.ss, n4, mult);
  if (!p4) return null;
  const a = p4.atr;
  const d = p4.dir;
  const w = words(d);
  const names = PHASE_NAMES[d];
  const price = x.price;
  const day = x.big?.day ?? null;

  // ---- 数字：这段低点（或更高的低点）、转强线、再往外最近的关键位、日线失效价
  // ① 下跌中：这段到现在的最低点（还在移动；收盘跌穿前一个低点时，阶段记的是被跌穿的那个低点）
  let core = p4.invalid;
  if (p4.stage === 1) {
    const i0 = x.h4.c.findIndex((b) => b.t === p4.lowT);
    for (let k = Math.max(i0, 0); k <= n4; k++) {
      const e = d > 0 ? x.h4.c[k].l : x.h4.c[k].h;
      if ((core - e) * d > 0) core = e;
    }
  }
  const nums: BriefNumber[] = [];
  const sideOf = (v: number): BriefNumber["side"] => (v >= price ? "above" : "below");
  nums.push({
    key: "core",
    label: p4.stage === 4 ? w.better : `这段${w.x}点`,
    price: core,
    note: p4.stage === 1 ? `还在${w.newX}，会跟着移动` : p4.stage === 4 ? `4 小时${w.down}它就算${names[3]}失败` : `4 小时${w.down}它就回到${names[0]}`,
    side: sideOf(core),
  });
  if (p4.stage < 4) {
    nums.push({ key: "turn", label: w.turnWord, price: p4.trigger, note: `${w.bounce} ${fmt(p4.bounce)} 外 0.1 倍 ATR，4 小时收盘${w.up}它${p4.checks[2] ? `就是${names[3]}` : `、再走出${w.better}才算${names[3]}`}`, side: sideOf(p4.trigger) });
  } else {
    // 已转强：前方最近的关键位（只说它在哪、来自哪里）
    const ahead = (d > 0 ? x.resistances : x.supports)[0];
    if (ahead) nums.push({ key: "near", label: `${d > 0 ? "上方" : "下方"}最近关键位`, price: ahead.price, note: `沿途可能停顿的地方 · ${source(ahead)}`, side: sideOf(ahead.price) });
  }
  // 再往外：跌破这段低点之后最近的关键位（离它至少 0.25 倍 ATR）
  const beyondList = d > 0 ? x.supports : x.resistances;
  const next = beyondList.find((l) => (core - l.price) * d > 0.25 * a) ?? null;
  if (next) nums.push({ key: "next", label: `${w.beyondSide}关键位`, price: next.price, note: `${w.down} ${fmt(core)} 之后最近的关键位 · ${source(next)}`, side: sideOf(next.price) });
  if (day?.flipAt != null) {
    const up = day.dir < 0;
    nums.push({ key: "flip", label: "日线失效价", price: day.flipAt, note: `日线收盘${up ? "站上" : "跌破"}它，日线${trendLabel(day)}才算失效`, side: "flip" });
  }
  // 太近的两个数只留更要紧的一个（这段低点 > 转强线 > 日线失效价 > 其他）
  const rank: Record<BriefNumber["key"], number> = { core: 0, turn: 1, flip: 2, next: 3, near: 3 };
  const kept: BriefNumber[] = [];
  for (const v of [...nums].sort((p, q) => rank[p.key] - rank[q.key])) if (!kept.some((k) => Math.abs(k.price - v.price) < 0.25 * a)) kept.push(v);
  kept.sort((p, q) => q.price - p.price);

  // ---- 区间带：止跌尝试 / 反弹时，这段低点到反弹高点（太宽的不画）
  const band = (p4.stage === 2 || p4.stage === 3) && Math.abs(p4.bounce - core) <= 4 * a ? { lo: Math.min(core, p4.bounce), hi: Math.max(core, p4.bounce), label: `${fmt(Math.min(core, p4.bounce))}–${fmt(Math.max(core, p4.bounce))} 是 4 小时这段${w.x}点到${w.bounce}` } : null;

  // ---- 一句话
  const dayPart = day ? `日线${trendLabel(day)}` : "";
  const title = `${dayPart}${dayPart ? "，" : ""}4 小时${names[p4.stage - 1]}`;
  const line =
    p4.stage === 1
      ? `4 小时还在${w.newX}（最${w.x} ${fmt(core)}）：${w.x}点站住之前不猜${d > 0 ? "底" : "顶"}。`
      : p4.stage === 2
        ? `${fmt(core)} 之后 4 小时没再${w.newX}，但${w.x}点还没站住（要${d > 0 ? "反弹" : "回落"}到 ${fmt(p4.heldAt)} 才算）；${w.down} ${fmt(core)} 就回到${names[0]}。`
        : p4.stage === 3
          ? `4 小时不${w.down} ${fmt(core)} 就还是${names[2]}；收盘${w.up} ${fmt(p4.trigger)}${p4.checks[2] ? "" : `、再走出${w.better}`}才算${names[3]}。`
          : `4 小时已${names[3]}；${w.down} ${fmt(core)}（${w.better}）就算${names[3]}失败。`;

  // ---- 各周期一格
  const cells: BriefCell[] = [];
  const p1 = x.h1 && x.h1.c.length > 50 ? phaseAt(x.h1.c, x.h1.atr, x.h1.ss, x.h1.c.length - 1, mult) : null;
  if (p1) {
    const nm = PHASE_NAMES[p1.dir][p1.stage - 1];
    cells.push({ tf: "1h", name: nm, tone: phaseTone(nm), text: phaseCellText(p1) });
  }
  cells.push({ tf: "4h", name: names[p4.stage - 1], tone: phaseTone(names[p4.stage - 1]), text: phaseCellText(p4) });
  if (x.big) cells.push(trendCell(x.big.day), trendCell(x.big.week));

  // ---- 接下来看什么：只写“收在哪 → 页面状态变成什么”
  const nextRows: BriefNext[] = [];
  const nextLevel = next ? `；${w.beyondSide}最近的关键位 ${fmt(next.price)}（沿途可能停顿的地方）` : "";
  nextRows.push(
    p4.stage === 1
      ? { when: `4 小时继续${w.newX}`, then: `还在${names[0]}${nextLevel}`, fact: null, tone: d > 0 ? "down" : "up" }
      : { when: `4 小时${w.down} ${fmt(core)}`, then: `${p4.stage === 4 ? `${names[3]}失败，` : ""}回到${names[0]}${nextLevel}`, fact: fact(p4, "back"), tone: d > 0 ? "down" : "up" },
  );
  if (p4.stage < 4)
    nextRows.push({ when: `4 小时收盘${w.up} ${fmt(p4.trigger)}`, then: p4.checks[2] ? `4 小时${names[3]}` : `还要再走出${w.better}，4 小时才算${names[3]}`, fact: fact(p4, "up"), tone: d > 0 ? "up" : "down" });
  else nextRows.push({ when: `4 小时${w.go}`, then: `${names[3]}延续；结构判定为趋势时进入${names[4]}`, fact: fact(p4, "up"), tone: d > 0 ? "up" : "down" });
  if (day?.flipAt != null) {
    const up = day.dir < 0;
    nextRows.push({ when: `日线收盘${up ? "站上" : "跌破"} ${fmt(day.flipAt)}`, then: `日线${trendLabel(day)}失效（保护${up ? "高" : "低"}点 ${fmt(day.protective)}）`, fact: null, tone: up ? "up" : "down" });
  }

  const against = day && day.dir !== 0 ? `日线向${DIR_WORD[day.dir]}：这时做${day.dir > 0 ? "空" : "多"}是逆日线，按规则半仓（同大趋势卡）。` : null;

  return { t: x.h4.c[n4].t, title, line, numbers: kept, band, cells, next: nextRows, against, foot: BRIEF_FOOT };
}

/** 命令行和测试用的纯文字版 */
export function briefText(b: MarketBrief): string[] {
  const out = [`行情导视：${b.title}`, `  ${b.line}`];
  out.push(`  ${b.numbers.map((v) => `${v.label} ${fmt(v.price)}`).join(" · ")}`);
  for (const v of b.numbers) out.push(`    ${v.label} ${fmt(v.price)}：${v.note}`);
  if (b.band) out.push(`  区间带：${b.band.label}`);
  out.push(`  各周期：${b.cells.map((c) => `${c.tf} ${c.name}（${c.text}）`).join("；")}`);
  for (const r of b.next) out.push(`  接下来：${r.when} → ${r.then}${r.fact ? `。${r.fact}` : ""}`);
  if (b.against) out.push(`  ${b.against}`);
  return out;
}
