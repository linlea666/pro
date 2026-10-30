import type { Candle } from "../types.ts";
import { BEYOND_ATR, FRESH_BARS } from "./watch.ts";
import { DEFAULT_SWING_ATR, type StructureState, type Swing } from "./structure.ts";

/**
 * 行情阶段（2026-10-30）：把一个周期的结构翻译成“下跌中 → 止跌尝试 → 反弹 → 转强 → 上升中”的哪一格、还差哪一步、
 * 跌破哪里作废。页面（盯盘页签的阶段卡）和 E33b 研究共用这一份。只读到第 n 根收盘为止的数据，规则不预测方向。
 *
 * 梯子的方向 `dir`：结构在下跌（或下跌之后的区间）时看“从下跌修复”（dir 1，守低点）；结构在上涨（或上涨之后的区间）时看
 * 镜像的“从上涨转弱”（dir −1，守高点）。四个条件（以 dir 1 说，镜像对称）：
 * 1. 不再创新低：最近 FRESH_BARS 根没有更低的低点（跌破上一个低点之后，以新的最低点算）；
 * 2. 低点站住：最低点已是确认的摆动低点（价格从它反弹了 `mult` 倍 ATR）；
 * 3. 更高的低点：这个低点是 HL（比前一个低点高）；
 * 4. 收盘站上反弹高点：低点确认之后，有收盘高于最近的摆动高点 BEYOND_ATR 倍 ATR（转强之后不因回落撤销，跌破低点才撤销）。
 * 阶段：1 不满足 → ① 下跌中；1 满足、2 不满足 → ② 止跌尝试；1、2 满足、3 和 4 没有都满足 → ③ 反弹；3、4 都满足 → ④ 转强。
 * ④ 在 15 分钟上就是盯盘“已转强”的同一判定（`turnAt`：最新低点是 HL，收盘高于最近高点 0.1 ATR）。
 * ⑤ 上升中 = 结构引擎判定为上升，这时梯子换到镜像一侧，从 ① 上涨中 开始。
 */

export type PhaseStage = 1 | 2 | 3 | 4;
export type PhaseDir = 1 | -1;

/** 五格的名字（第五格是终点：结构引擎判定为反方向的趋势）。 */
export const PHASE_NAMES: Record<PhaseDir, readonly [string, string, string, string, string]> = {
  1: ["下跌中", "止跌尝试", "反弹", "转强", "上升中"],
  [-1]: ["上涨中", "滞涨尝试", "回调", "转弱", "下跌中"],
};

export interface Phase {
  dir: PhaseDir;
  stage: PhaseStage;
  /** 四个条件：不再创新低、低点站住、更高的低点、收盘站上反弹高点 */
  checks: [boolean, boolean, boolean, boolean];
  /** 这一段的最低点（dir −1 为最高点）和它那根 K 线的开盘时刻 */
  low: number;
  lowT: number;
  /** 已确认的更高的低点（dir −1 为更低的高点），没有为 null */
  higherLow: number | null;
  /** 回落中、还没确认、但没有跌破最低点的低点：可能成为更高的低点 */
  candidate: number | null;
  /** 最近的反弹高点（dir −1 为回落低点），收盘越过它 BEYOND_ATR 倍 ATR 才满足条件 4 */
  bounce: number;
  /** 条件 4 的收盘价门槛：bounce 外 BEYOND_ATR 倍 ATR（按最后一根的 ATR） */
  trigger: number;
  /** ② 时：价格要到这里，最低点才算站住（最低点外 mult 倍 ATR） */
  heldAt: number | null;
  /** 收盘越过反弹高点，但还没有更高的低点（V 形） */
  vShape: boolean;
  /** 跌破这里（dir −1 为涨破）就回到 ① */
  invalid: number;
  /** 最后一根已收盘 K 线的开盘时刻和 ATR */
  t: number;
  atr: number;
}

const isHigherLow = (s: Swing, dir: PhaseDir) => s.label === (dir > 0 ? "HL" : "LH");

/** 梯子的方向：下跌 → 1，上涨 → −1；区间看之前最近的趋势，再没有就看最后一段是跌（1）还是涨（−1）。 */
export function phaseDir(ss: StructureState[], n: number): PhaseDir | null {
  const s = ss[n];
  if (!s?.lastHigh || !s.lastLow) return null;
  if (s.state === "down") return 1;
  if (s.state === "up") return -1;
  for (let k = n - 1; k >= 0 && k >= n - 2000; k--) {
    const st = ss[k]?.state;
    if (st === "down") return 1;
    if (st === "up") return -1;
  }
  return s.lastHigh.i > s.lastLow.i ? 1 : -1;
}

/**
 * 第 n 根收盘时这个周期在梯子的哪一格。`ss` 是同一组 K 线的 `structureSeries`（同一个 `mult`），`atr` 同长度。
 * 数据不够（还没有一高一低两个摆动点、ATR 无效）时返回 null。
 */
export function phaseAt(c: Candle[], atr: number[], ss: StructureState[], n: number, mult = DEFAULT_SWING_ATR): Phase | null {
  const s = ss[n];
  const a = atr[n];
  const dir = phaseDir(ss, n);
  if (!s || !dir || !(a > 0)) return null;
  const D = (dir > 0 ? s.lastLow : s.lastHigh)!; // 守住的一侧：最近的摆动低点
  const O = (dir > 0 ? s.lastHigh : s.lastLow)!; // 另一侧：最近的摆动高点
  const prevD = dir > 0 ? s.prevLow : s.prevHigh;
  const ext = (k: number) => (dir > 0 ? c[k].l : c[k].h);
  const beyond = (p: number, q: number) => (p - q) * dir > 0; // p 在 q 的“好”的一边（dir 1：更高）
  const trigger = O.price + dir * BEYOND_ATR * a;
  const closedPast = (from: number) => {
    for (let k = Math.max(from, 0); k <= n; k++) if ((c[k].c - O.price) * dir > BEYOND_ATR * (atr[k] > 0 ? atr[k] : a)) return true;
    return false;
  };
  const base = { dir, bounce: O.price, trigger, t: c[n].t, atr: a };

  if (O.i > D.i) {
    // 最后一段是朝坏的方向走（从反弹高点回落）：这段的最低点
    let x = ext(O.i), xi = O.i;
    for (let k = O.i + 1; k <= n; k++)
      if (beyond(x, ext(k))) {
        x = ext(k);
        xi = k;
      }
    if (!beyond(x, D.price)) {
      // 跌破了上一个低点：新的一段下跌，最低点还没站住
      const noNew = xi <= n - FRESH_BARS;
      return {
        ...base,
        stage: noNew ? 2 : 1,
        checks: [noNew, false, false, false],
        low: x,
        lowT: c[xi].t,
        higherLow: null,
        candidate: null,
        heldAt: noNew ? x + dir * mult * a : null,
        vShape: false,
        invalid: x,
      };
    }
    // 回落没有跌破最低点：最低点已站住
    const hl = isHigherLow(D, dir);
    const reclaim = closedPast(O.confirmedAt);
    return {
      ...base,
      stage: hl && reclaim ? 4 : 3,
      checks: [true, true, hl, reclaim],
      low: hl && prevD ? prevD.price : D.price,
      lowT: hl && prevD ? prevD.t : D.t,
      higherLow: hl ? D.price : null,
      candidate: hl ? null : x,
      heldAt: null,
      vShape: reclaim && !hl,
      invalid: D.price,
    };
  }

  // 最后一段是从低点反弹：最低点已站住
  if ((D.price - c[n].c) * dir > BEYOND_ATR * a)
    return { ...base, stage: 1, checks: [false, false, false, false], low: D.price, lowT: D.t, higherLow: null, candidate: null, heldAt: null, vShape: false, invalid: D.price };
  const hl = isHigherLow(D, dir);
  const reclaim = closedPast(D.confirmedAt);
  return {
    ...base,
    stage: hl && reclaim ? 4 : 3,
    checks: [true, true, hl, reclaim],
    low: hl && prevD ? prevD.price : D.price,
    lowT: hl && prevD ? prevD.t : D.t,
    higherLow: hl ? D.price : null,
    candidate: null,
    heldAt: null,
    vShape: reclaim && !hl,
    invalid: D.price,
  };
}

/**
 * E33b（2026-10-30，scripts/research-data/e33.ts，结果在项目文件夹 e33/）：BTC / ETH 永续，1 小时 2020 年起、4 小时 2021-10 起，
 * 每次进入这一格之后 200 根内先到哪里。②③：先到 ④ 的比例 `up`、先回 ① 的比例 `back`；④：先继续创新高（梯子换边后的 ①）
 * `up`、先收盘跌破更高的低点 `back`。中位根数 `upBars` / `backBars`。只描述，不判断优势；其他 8 个币的比例和它们相差在 8 个百分点以内。
 */
export const PHASE_FACTS: Record<string, { n: number; up: number; back: number; upBars: number; backBars: number }> = {
  "1h:1:2": { n: 527, up: 14, back: 85, upBars: 35, backBars: 7 },
  "1h:1:3": { n: 2646, up: 25, back: 73, upBars: 23, backBars: 13 },
  "1h:1:4": { n: 482, up: 66, back: 34, upBars: 23, backBars: 18 },
  "1h:-1:2": { n: 809, up: 13, back: 86, upBars: 25, backBars: 6 },
  "1h:-1:3": { n: 2849, up: 21, back: 77, upBars: 20, backBars: 14 },
  "1h:-1:4": { n: 456, up: 58, back: 41, upBars: 19, backBars: 22 },
  "4h:1:2": { n: 105, up: 8, back: 90, upBars: 31, backBars: 9 },
  "4h:1:3": { n: 482, up: 20, back: 77, upBars: 25, backBars: 14 },
  "4h:1:4": { n: 75, up: 61, back: 39, upBars: 22, backBars: 24 },
  "4h:-1:2": { n: 154, up: 8, back: 92, upBars: 22, backBars: 6 },
  "4h:-1:3": { n: 529, up: 18, back: 79, upBars: 19, backBars: 13 },
  "4h:-1:4": { n: 76, up: 66, back: 34, upBars: 18, backBars: 34 },
};

const TF_WORD: Record<string, string> = { "1h": "1 小时", "4h": "4 小时" };

/** 这一格的历史一句话（只有 1 小时、4 小时的 ②③④；少于 20 次不写）。 */
export function phaseFact(tf: string, p: Pick<Phase, "dir" | "stage">): string | null {
  const f = PHASE_FACTS[`${tf}:${p.dir}:${p.stage}`];
  if (!f || f.n < 20 || !TF_WORD[tf]) return null;
  const names = PHASE_NAMES[p.dir];
  const here = `${TF_WORD[tf]}${names[p.stage - 1]}`;
  const times = `${f.n.toLocaleString("en-US")} 次 `;
  const span = (bars: number) => (tf === "1h" ? `${bars} 小时` : `${bars} 根 4 小时 K 线`);
  if (p.stage === 4) {
    const go = p.dir > 0 ? "继续创新高" : "继续创新低";
    const fail = p.dir > 0 ? "收盘跌破更高的低点" : "收盘涨破更低的高点";
    return `BTC / ETH 历史上 ${times}${here}之后，${f.up}% 先${go}，${f.back}% 先${fail}（转${p.dir > 0 ? "强" : "弱"}失败）。只描述，不预测这一次。`;
  }
  return `BTC / ETH 历史上 ${times}${here}之后，${f.up}% 先走到${names[3]}（中位 ${span(f.upBars)}），${f.back}% 先回到${names[0]}（中位 ${span(f.backBars)}）。只描述，不预测这一次。`;
}

/**
 * E33a 早提示（2026-10-30，用户定的标准“不劣于 15 分钟转强且更早”）：15 分钟摆动点改按 1 倍 ATR 确认（现在 2 倍）的同一个
 * 转强判定，在盯盘事件上平均早约 34 根 15 分钟（中位），对同一批事件的转强入场 −0.00R、对随机入场 +0.01R，BTC / ETH、前后
 * 两半、样本外都不差于 −0.1R，标准通过；但 24 小时内被扫 41%（转强 31%）。只作提前准备的提示，正式入场仍是“已转强”。
 */
export const EARLY_SWING_ATR = 1;
export const EARLY_FACT = "历史上（10 个币 2022 年起，样本内约 5,700 个盯盘事件）这种早提示比等正式转强中位早约 8 小时，按同样的止损结果差不多，但 24 小时内被扫的比例更高（41% 对 31%）。它只是让你提前准备，正式入场仍等页面上的“已转强 / 已转弱”。";
