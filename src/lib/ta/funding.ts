/**
 * 趋势页“资金费率”一行（2026-11-07，用户在决策卡上定“按方案做”）：现在合约里谁付谁、付得多不多、拿一笔单每天付 / 收多少。
 * 只描述，不预测方向：费率拥挤在研究里没有加分（E17、E19b），扫低时费率转负之后略好但没达标（E43）。
 *
 * 纯函数，页面、计划接口和命令行共用。费率都是小数（0.0001 = 0.01%），正数 = 做多的人付给做空的人。
 */

export const FUNDING_RULES = {
  /** 交易所的默认费率（没有溢价时就是这个数），每 8 小时 */
  base8h: 0.0001,
  /** 折成每 8 小时后绝对值小于它算“基本持平” */
  flat8h: 0.00005,
  /** 正费率在它以内算“正常”（默认 0.01% 附近） */
  normal8h: 0.00015,
  /** 绝对值超过它算“很高” */
  high8h: 0.0003,
  /**
   * 拥挤：在之前 days 天已结算的费率里排在最高 / 最低 crowdPct%（同研究 fundingFuel 的口径），
   * 并且多头要高于“正常”（> normal8h）、空头要真的为负（< −flat8h）。只看排位时，BTC 2026-05 到 10 月
   * 没有一期超过默认的 0.01%，默认值本身就排在前 20%，会把“正常”写成“拥挤”（2026-11-07 回看 8/19 那段发现）。
   */
  days: 90,
  crowdPct: 20,
  /** 已结算的少于这么多期不算分位 */
  minSamples: 60,
  /** 每天费用按这么多 U 的仓位写 */
  notional: 10000,
} as const;

export type FundingSide = "longs" | "shorts" | "flat";
export type FundingLevel = "flat" | "normal" | "slight" | "clear" | "high";

export interface FundingView {
  /** 本期费率（实时为正在走的这一期的预估；回放为当时最近一次已结算的） */
  rate: number;
  /** 折成每 8 小时 */
  rate8h: number;
  intervalH: number;
  /** true：实时本期预估；false：已结算的 */
  live: boolean;
  /** 下次结算（Unix 秒），回放或不知道时为 null */
  nextAt: number | null;
  side: FundingSide;
  level: FundingLevel;
  /** 在之前 90 天已结算费率里比它低的占几成（%），历史不够时为 null */
  pct: number | null;
  /** longs：多头拥挤（前 20%）；shorts：空头拥挤（后 20%） */
  crowd: "longs" | "shorts" | null;
  /** 近 7 天已结算的平均 */
  avg7d: number | null;
  /** 最近已结算的连续几期同号（正 / 负），0 期或没有历史为 null */
  streak: { sign: 1 | -1; n: number } | null;
  /** 每 FUNDING_RULES.notional U 的多单每天付（正）/ 收（负）多少 U；空单相反 */
  longPerDay: number;
}

function rank(sorted: number[], x: number): number {
  // 比它小的 + 一半和它相等的（很多期正好是默认 0.01%）
  let lt = 0, eq = 0;
  for (const v of sorted) {
    if (v < x) lt++;
    else if (v === x) eq++;
  }
  return Math.round(((lt + eq / 2) / sorted.length) * 1000) / 10;
}

/**
 * @param rate 本期费率
 * @param history 已结算的费率（时间升序，t 为结算时刻 Unix 秒），只用 t ≤ at 的
 * @param at 现在（或回放的时刻）
 */
export function fundingView(o: { rate: number; intervalH: number | null; live: boolean; nextAt: number | null; history: { t: number; rate: number }[]; at: number }): FundingView {
  const R = FUNDING_RULES;
  const intervalH = o.intervalH && o.intervalH > 0 ? o.intervalH : 8;
  const rate8h = (o.rate * 8) / intervalH;
  const side: FundingSide = rate8h > R.flat8h ? "longs" : rate8h < -R.flat8h ? "shorts" : "flat";
  const a = Math.abs(rate8h);
  const level: FundingLevel =
    side === "flat" ? "flat" : a > R.high8h ? "high" : side === "longs" ? (a <= R.normal8h ? "normal" : "clear") : a <= R.base8h ? "slight" : "clear";

  const past = o.history.filter((h) => h.t <= o.at);
  const win = past.filter((h) => h.t > o.at - R.days * 86400).map((h) => (h.rate * 8) / intervalH);
  const pct = win.length >= R.minSamples ? rank([...win].sort((x, y) => x - y), rate8h) : null;
  const crowd =
    pct == null ? null
    : pct >= 100 - R.crowdPct && rate8h > R.normal8h ? "longs"
    : pct <= R.crowdPct && rate8h < -R.flat8h ? "shorts"
    : null;
  const wk = past.filter((h) => h.t > o.at - 7 * 86400);
  const avg7d = wk.length ? wk.reduce((s, h) => s + h.rate, 0) / wk.length : null;
  let streak: FundingView["streak"] = null;
  if (past.length && past[past.length - 1].rate !== 0) {
    const sign = past[past.length - 1].rate > 0 ? 1 : -1;
    let n = 0;
    for (let i = past.length - 1; i >= 0 && Math.sign(past[i].rate) === sign; i--) n++;
    streak = { sign, n };
  }
  return { rate: o.rate, rate8h, intervalH, live: o.live, nextAt: o.nextAt, side, level, pct, crowd, avg7d, streak, longPerDay: R.notional * o.rate * (24 / intervalH) };
}

const pctText = (x: number, d = 4) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(d)}%`;
const u = (x: number) => (Math.abs(x) >= 10 ? Math.abs(x).toFixed(0) : Math.abs(x).toFixed(1));

/** 一句话：谁付谁、付得多不多 */
export function fundingHeadline(v: FundingView): string {
  const who = v.side === "longs" ? "多头付给空头" : v.side === "shorts" ? "空头付给多头" : "基本持平（谁也不怎么付）";
  const how =
    v.level === "normal" ? "，在交易所默认的 0.01% 附近"
    : v.level === "clear" ? (v.side === "longs" ? "，高于默认的 0.01%" : "，负得比较明显")
    : v.level === "high" ? "，很高"
    : v.level === "slight" ? "，只负一点"
    : "，比交易所默认的 0.01% 低";
  const crowd = v.crowd === "longs" ? "；在最近 90 天里排在最高的 20%，做多的人偏拥挤" : v.crowd === "shorts" ? "；在最近 90 天里排在最低的 20%，做空的人偏拥挤" : "";
  return `资金费率 ${pctText(v.rate)} / ${v.intervalH} 小时：${who}${how}${crowd}。`;
}

/** 拿一笔单每天付 / 收多少（按 FUNDING_RULES.notional U） */
export function fundingCost(v: FundingView, dir: 1 | -1): string {
  const x = v.longPerDay * dir;
  const n = FUNDING_RULES.notional.toLocaleString("en-US");
  if (Math.abs(x) < 0.05) return `${dir > 0 ? "多单" : "空单"}每 ${n} U 每天几乎不付也不收资金费`;
  return `${dir > 0 ? "多单" : "空单"}每 ${n} U 每天约${x > 0 ? "付" : "收"} ${u(x)} U 资金费`;
}

/** 数字一行：每天费用、近 7 天平均、连续几期、结算时间 */
export function fundingNumbers(v: FundingView, hm?: (sec: number) => string): string {
  const parts = [`${fundingCost(v, 1)}，空单相反`];
  if (v.avg7d != null) parts.push(`近 7 天平均 ${pctText(v.avg7d)}`);
  if (v.streak && v.streak.n >= 2) parts.push(`已连续 ${v.streak.n} 期${v.streak.sign > 0 ? "为正" : "为负"}`);
  if (v.pct != null) parts.push(`比最近 90 天 ${Math.round(v.pct)}% 的结算高`);
  if (v.nextAt != null && hm) parts.push(`${hm(v.nextAt)} 结算`);
  if (!v.live) parts.push("这是最近一次已结算的费率");
  return parts.join(" · ");
}

/** 页面唯一能说的研究结论 */
export const FUNDING_FACT =
  "资金费率只说明合约里哪边更拥挤、拿单要付多少钱，不预测涨跌：研究里“费率在反方向拥挤”对守位做法和盯盘转强都没有加分（E17、E19b），扫低时费率转负之后 1–3 天略好但没达标（E43）。";

/** 命令行和测试用 */
export function fundingLines(v: FundingView, hm?: (sec: number) => string): string[] {
  return [fundingHeadline(v), `  ${fundingNumbers(v, hm)}`];
}
