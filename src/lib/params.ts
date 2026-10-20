import type { Timeframe } from "./types.ts";

/**
 * Every tunable engine parameter, with its default, range and explanation.
 * The engines read typed views of these values; the admin tuning page renders
 * its forms from the same schema. Stored overrides only hold values that
 * differ from the defaults, so improving a default in code still reaches
 * installs that never touched it.
 */

export interface ParamDef {
  key: string;
  label: string;
  hint: string;
  type: "number" | "bool";
  default: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface ParamGroup {
  title: string;
  hint?: string;
  params: ParamDef[];
}

export interface ParamModule {
  id: "levels" | "td" | "indicators" | "trend" | "verdict" | "plan" | "stats";
  title: string;
  hint: string;
  groups: ParamGroup[];
}

const n = (key: string, label: string, def: number, min: number, max: number, step: number, hint: string, unit?: string): ParamDef => ({ key, label, hint, type: "number", default: def, min, max, step, unit });
const b = (key: string, label: string, def: boolean, hint: string): ParamDef => ({ key, label, hint, type: "bool", default: def });

const TFS: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];
const TF_NAME: Record<Timeframe, string> = { "5m": "5分钟", "15m": "15分钟", "1h": "1小时", "4h": "4小时", "1d": "日线", "1w": "周线" };

export const LEVEL_METHODS = ["swing", "fractal", "volume", "pivot", "camarilla", "fibPivot", "fib", "prevHL", "donchian", "keltner", "bollinger", "ma", "avwap", "round"] as const;
const METHOD_LABEL: Record<(typeof LEVEL_METHODS)[number], string> = {
  swing: "摆动高低",
  fractal: "Williams 分形",
  volume: "成交量分布",
  pivot: "经典 Pivot",
  camarilla: "Camarilla",
  fibPivot: "Fibonacci Pivot",
  fib: "Fibonacci 回撤",
  prevHL: "前日/周/月高低",
  donchian: "Donchian 通道",
  keltner: "Keltner 通道",
  bollinger: "布林带",
  ma: "均线",
  avwap: "锚定 VWAP",
  round: "整数关口",
};
const METHOD_DEFAULT: Record<(typeof LEVEL_METHODS)[number], number> = {
  swing: 1.3, fractal: 0.6, volume: 1.4, pivot: 1.1, camarilla: 0.7, fibPivot: 0.6, fib: 0.9,
  prevHL: 1.2, donchian: 0.7, keltner: 0.4, bollinger: 0.4, ma: 0.9, avwap: 0.9, round: 0.5,
};
const TF_LEVEL_DEFAULT: Record<Timeframe, number> = { "5m": 0.35, "15m": 0.5, "1h": 0.75, "4h": 1, "1d": 1.5, "1w": 2 };

export const INDICATOR_IDS = [
  "ema_cross", "golden_cross", "ma_stack", "price_sma200", "macd", "adx", "psar", "aroon", "ichimoku", "slope",
  "rsi", "rsi_div", "stoch", "cci", "willr", "roc", "mfi",
  "bollinger", "squeeze", "keltner", "atr",
  "obv", "cmf", "adl", "force", "vwap", "vol_ratio", "candles",
] as const;
const INDICATOR_LABEL: Record<(typeof INDICATOR_IDS)[number], string> = {
  ema_cross: "EMA 快慢线", golden_cross: "金叉/死叉 50/200", ma_stack: "均线排列", price_sma200: "价格 vs 200 均线", macd: "MACD",
  adx: "ADX / DMI", psar: "抛物线 SAR", aroon: "Aroon", ichimoku: "一目均衡云", slope: "回归斜率",
  rsi: "RSI", rsi_div: "RSI 背离", stoch: "随机指标 KD", cci: "CCI", willr: "威廉 %R", roc: "ROC", mfi: "MFI",
  bollinger: "布林带", squeeze: "布林收口", keltner: "肯特纳通道", atr: "ATR",
  obv: "OBV", cmf: "CMF", adl: "累积/派发线", force: "强力指数", vwap: "VWAP", vol_ratio: "量比", candles: "K 线形态",
};

export const TREND_VOTERS = ["ema_cross", "golden_cross", "ma_stack", "price_sma200", "macd", "adx", "psar", "aroon", "ichimoku", "slope"] as const;
const TREND_DEFAULT: Record<(typeof TREND_VOTERS)[number], number> = {
  ema_cross: 1, golden_cross: 1.2, ma_stack: 1.3, price_sma200: 1, macd: 0.8, adx: 1.2, psar: 0.6, aroon: 0.7, ichimoku: 1, slope: 1,
};
const HORIZON_DEFAULT: Record<Timeframe, number> = { "5m": 24, "15m": 16, "1h": 24, "4h": 18, "1d": 10, "1w": 4 };

export const PARAM_MODULES: ParamModule[] = [
  {
    id: "levels",
    title: "支撑阻力",
    hint: "多种方法在多个周期上提出候选价位，按价格聚类后打分。",
    groups: [
      {
        title: "聚类",
        params: [
          n("levels.bandAtr", "聚类带宽", 0.6, 0.2, 2, 0.05, "距离在这个范围内的候选价位会合并成一个关键位。越大合并得越多，关键位越少越“粗”。", "× ATR"),
          n("levels.bandMinPct", "最小带宽", 0.25, 0.05, 2, 0.05, "带宽不会小于价格的这个比例，避免波动很小时关键位过碎。", "% 价格"),
          n("levels.spacing", "相邻关键位最小间距", 1.5, 0.5, 4, 0.1, "同一侧两个关键位至少相隔多少个带宽，避免挤在一起。", "× 带宽"),
          n("levels.maxDistancePct", "最远显示距离", 30, 5, 60, 1, "离现价超过这个比例的价位不显示。", "%"),
          n("levels.methodBonus", "多方法加成", 0.3, 0, 1, 0.05, "每多一种不同方法指向同一价位，得分额外增加的比例。"),
          n("levels.tfBonus", "多周期加成", 0.15, 0, 1, 0.05, "每多一个周期指向同一价位，得分额外增加的比例。"),
        ],
      },
      {
        title: "周期权重",
        hint: "每个候选价位的得分乘以它所在周期的权重。设为 0 表示不使用该周期。",
        params: TFS.map((tf) => n(`levels.tf.${tf}`, TF_NAME[tf], TF_LEVEL_DEFAULT[tf], 0, 5, 0.05, `${TF_NAME[tf]}候选价位的权重`)),
      },
      {
        title: "方法权重",
        hint: "调高某个方法，它给出的价位更容易胜出。设为 0 表示完全不用这个方法。",
        params: LEVEL_METHODS.map((m) => n(`levels.m.${m}`, METHOD_LABEL[m], METHOD_DEFAULT[m], 0, 3, 0.05, `${METHOD_LABEL[m]}每个候选价位的基础分`)),
      },
    ],
  },
  {
    id: "td",
    title: "TD 序列",
    hint: "DeMark 的标准参数是 9 / 4 / 13 / 2。改动后图上的计数和统计都会跟着变。",
    groups: [
      {
        title: "Setup 与 Countdown",
        params: [
          n("td.setupLength", "Setup 长度", 9, 5, 13, 1, "连续多少根 K 线满足条件算完成一次 Setup（标准是 9）。"),
          n("td.setupLookback", "Setup 比较根数", 4, 2, 6, 1, "和多少根之前的收盘价比较（标准是 4）。"),
          n("td.countdownLength", "Countdown 长度", 13, 8, 21, 1, "累计多少根合格 K 线算完成 Countdown（标准是 13）。"),
          n("td.countdownLookback", "Countdown 比较根数", 2, 1, 4, 1, "和多少根之前的最高价 / 最低价比较（标准是 2）。"),
        ],
      },
    ],
  },
  {
    id: "indicators",
    title: "指标共振",
    hint: "关掉的指标不参与投票，也不参与趋势强度和红绿灯的计算。",
    groups: [
      {
        title: "阈值",
        params: [
          n("ind.rsiLow", "RSI 超卖线", 30, 10, 45, 1, "RSI 低于这个值时判为超卖（看多）。"),
          n("ind.rsiHigh", "RSI 超买线", 70, 55, 90, 1, "RSI 高于这个值时判为超买（看空）。"),
          n("ind.strongPct", "强共振门槛", 40, 20, 80, 5, "多空净票数达到指标总数的这个比例，算一次“强共振”信号（用于胜率统计）。", "%"),
        ],
      },
      {
        title: "启用的指标",
        params: INDICATOR_IDS.map((id) => b(`ind.on.${id}`, INDICATOR_LABEL[id], true, `是否让 ${INDICATOR_LABEL[id]} 参与投票`)),
      },
    ],
  },
  {
    id: "trend",
    title: "趋势强度",
    hint: "10 个趋势指标加权投票，再按 ADX 力度和 DI 优势调整可信度。",
    groups: [
      {
        title: "可信度与分界",
        params: [
          n("trend.adxFloor", "ADX 起点", 10, 0, 30, 1, "ADX 低于这个值时，趋势可信度降到最低。"),
          n("trend.adxSpan", "ADX 满分跨度", 25, 5, 60, 1, "ADX 比起点高出这么多时，可信度达到 100%。"),
          n("trend.diFull", "DI 优势满分", 0.25, 0.05, 0.6, 0.01, "+DI 和 −DI 相差达到两者之和的这个比例时，方向可信度达到 100%。"),
          n("trend.mild", "趋势成立线", 15, 5, 40, 1, "分数绝对值超过它算“温和上涨 / 下跌”，以内算震荡。"),
          n("trend.strong", "强势趋势线", 45, 20, 90, 1, "分数绝对值超过它算“强势上涨 / 下跌”。"),
        ],
      },
      {
        title: "投票权重",
        params: TREND_VOTERS.map((id) => n(`trend.w.${id}`, INDICATOR_LABEL[id], TREND_DEFAULT[id], 0, 3, 0.05, `${INDICATOR_LABEL[id]}在趋势投票中的权重`)),
      },
      {
        title: "市场结构",
        params: [
          n(
            "structure.swingAtr",
            "摆动点确认幅度",
            2,
            1,
            4,
            0.5,
            "价格从高点回落（或从低点反弹）超过这么多倍 ATR，才确认一个摆动高点 / 低点。越大，结构越粗、变化越慢。",
            "ATR",
          ),
        ],
      },
    ],
  },
  {
    id: "verdict",
    title: "红绿灯",
    hint: "综合分 = 四个维度按权重加总（权重会自动归一化），超过阈值亮绿灯，低于负阈值亮红灯。",
    groups: [
      {
        title: "维度权重",
        params: [
          n("verdict.w.trend", "趋势", 40, 0, 100, 1, "趋势强度的权重。"),
          n("verdict.w.momentum", "动量资金", 25, 0, 100, 1, "动量、量能、形态类指标净票数的权重。"),
          n("verdict.w.position", "所处位置", 20, 0, 100, 1, "离支撑近还是离阻力近的权重。"),
          n("verdict.w.timing", "时机（TD）", 15, 0, 100, 1, "TD 序列时机信号的权重。"),
        ],
      },
      {
        title: "阈值",
        params: [n("verdict.threshold", "红绿灯阈值", 18, 5, 50, 1, "综合分 ≥ 阈值亮绿灯，≤ −阈值亮红灯，中间是黄灯。")],
      },
      {
        title: "动量资金的计票方式",
        params: [
          b(
            "verdict.familyVotes",
            "按指标家族计票",
            false,
            "打开后，动量资金分项先在高度相关的指标家族内取平均，每个家族只算一票（26 个指标约等于 6 个独立意见）。上线前请先用研究框架对比成绩单。",
          ),
        ],
      },
      {
        title: "止损参考",
        params: [
          n("verdict.stopQuantile", "扫损缓冲分位数", 80, 50, 95, 5, "止损放在结构高低点之外多远：取历史上“守住的位被刺穿多深”的这个分位数。80 表示八成守住的位刺穿得没这么深。", "%"),
        ],
      },
    ],
  },
  {
    id: "plan",
    title: "交易计划",
    hint: "“趋势与计划”页的规则。守位做法的定义和研究报告（守位依据）是同一份代码；改了这里，要等下一份研究报告才有对应的历史数字，在那之前页面不显示这部分数字。",
    groups: [
      {
        title: "守位做法",
        hint: "价格来到完好的高低点（或创新高 / 新低）、扫过后收回或长影线拒绝，之后第一次收盘拐回时入场。研究里没有证明它比随机入场好，页面照实标注。",
        params: [
          n("defend.stallBars", "拐回的等待根数", 3, 1, 6, 1, "极点之后多少根 K 线内要出现第一次收盘拐回，才算一次守位。", "根"),
          n("defend.freshBars", "新高 / 新低的回看根数", 50, 20, 200, 10, "附近没有完好的位时，极点要是最近这么多根里的最低（最高）价，才算新低（新高）。", "根"),
          n("defend.reachAtr", "离位多近算到位", 0.25, 0, 1, 0.05, "极点离完好的位还差这么多倍 ATR 以内，也算回到了这个位。", "ATR"),
          n("defend.minNearAtr", "近止损最小距离", 0.5, 0.2, 2, 0.1, "近止损（1 小时极点之外）离入场至少这么多倍入场周期的 ATR，太近会被正常波动扫掉。", "ATR"),
        ],
      },
    ],
  },
  {
    id: "stats",
    title: "胜率统计",
    hint: "判断一个信号“对不对”时，看它出现后多少根 K 线的价格；以及给信号贴“证据较强”标签前要过的检验。",
    groups: [
      {
        title: "统计口径",
        params: [
          n("stats.minSamples", "最少样本数", 30, 10, 200, 1, "互不重叠的样本少于这个数，一律显示“证据不足”。", "次"),
          n("stats.costPct", "往返交易成本", 0.15, 0, 1, 0.01, "每笔开仓加平仓的手续费与滑点，从每个样本的收益里扣掉。默认按合约吃单 0.05% × 2 加 0.05% 滑点。", "%"),
          n("stats.alpha", "显著性水平", 0.05, 0.01, 0.2, 0.01, "多重检验校正后的错误发现率。越小越严格，贴“证据较强”的信号越少。"),
        ],
      },
      {
        title: "验证窗口",
        params: TFS.map((tf) => n(`stats.h.${tf}`, TF_NAME[tf], HORIZON_DEFAULT[tf], 2, 120, 1, `${TF_NAME[tf]}信号出现后看多少根 K 线`, "根")),
      },
    ],
  },
];

export type ParamValues = Record<string, number | boolean>;

export const PARAM_DEFS: Map<string, ParamDef> = new Map(PARAM_MODULES.flatMap((m) => m.groups.flatMap((g) => g.params)).map((p) => [p.key, p]));
export const DEFAULT_PARAMS: ParamValues = Object.fromEntries([...PARAM_DEFS.values()].map((p) => [p.key, p.default]));

/** Merge overrides onto defaults, dropping unknown keys and clamping to range. */
export function resolveParams(overrides: ParamValues = {}): ParamValues {
  const out: ParamValues = { ...DEFAULT_PARAMS };
  for (const [k, v] of Object.entries(overrides)) {
    const def = PARAM_DEFS.get(k);
    if (!def) continue;
    if (def.type === "bool") out[k] = Boolean(v);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, v));
  }
  return out;
}

/** Validate an override set; returns an error message or null. */
export function validateParams(values: ParamValues): string | null {
  for (const [k, v] of Object.entries(values)) {
    const def = PARAM_DEFS.get(k);
    if (!def) return `未知参数 ${k}`;
    if (def.type === "bool") {
      if (typeof v !== "boolean") return `${def.label} 必须是开或关`;
    } else {
      if (typeof v !== "number" || !Number.isFinite(v)) return `${def.label} 必须是数字`;
      if ((def.min != null && v < def.min) || (def.max != null && v > def.max)) return `${def.label} 需在 ${def.min}–${def.max} 之间`;
    }
  }
  if (Number(values["ind.rsiLow"] ?? 30) >= Number(values["ind.rsiHigh"] ?? 70)) return "RSI 超卖线必须低于超买线";
  if (Number(values["trend.mild"] ?? 15) >= Number(values["trend.strong"] ?? 45)) return "趋势成立线必须低于强势趋势线";
  return null;
}

/** Keep only values that differ from the defaults. */
export function diffFromDefaults(values: ParamValues): ParamValues {
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => PARAM_DEFS.has(k) && DEFAULT_PARAMS[k] !== v));
}

// ---------------------------------------------------------------- typed views used by the engines

const num = (p: ParamValues, k: string) => Number(p[k]);

export interface EngineParams {
  levels: {
    bandAtr: number;
    bandMinPct: number;
    spacing: number;
    maxDistancePct: number;
    methodBonus: number;
    tfBonus: number;
    tfWeight: Record<Timeframe, number>;
    methodWeight: Record<(typeof LEVEL_METHODS)[number], number>;
  };
  td: { setupLength: number; setupLookback: number; countdownLength: number; countdownLookback: number };
  indicators: { enabled: Set<string>; rsiLow: number; rsiHigh: number; strongPct: number };
  trend: { adxFloor: number; adxSpan: number; diFull: number; mild: number; strong: number; weights: Record<string, number> };
  structure: { swingAtr: number };
  /** defend-the-level plans (src/lib/ta/defend.ts) */
  defend: { stallBars: number; freshBars: number; reachAtr: number; minNearAtr: number };
  verdict: { trend: number; momentum: number; position: number; timing: number; threshold: number; stopQuantile: number; familyVotes: boolean };
  horizon: Record<Timeframe, number>;
  stats: { minSamples: number; costPct: number; alpha: number };
}

export function engineParams(values: ParamValues = DEFAULT_PARAMS): EngineParams {
  const p = resolveParams(values);
  const w = { trend: num(p, "verdict.w.trend"), momentum: num(p, "verdict.w.momentum"), position: num(p, "verdict.w.position"), timing: num(p, "verdict.w.timing") };
  const sum = w.trend + w.momentum + w.position + w.timing || 1;
  return {
    levels: {
      bandAtr: num(p, "levels.bandAtr"),
      bandMinPct: num(p, "levels.bandMinPct"),
      spacing: num(p, "levels.spacing"),
      maxDistancePct: num(p, "levels.maxDistancePct"),
      methodBonus: num(p, "levels.methodBonus"),
      tfBonus: num(p, "levels.tfBonus"),
      tfWeight: Object.fromEntries(TFS.map((tf) => [tf, num(p, `levels.tf.${tf}`)])) as Record<Timeframe, number>,
      methodWeight: Object.fromEntries(LEVEL_METHODS.map((m) => [m, num(p, `levels.m.${m}`)])) as EngineParams["levels"]["methodWeight"],
    },
    td: {
      setupLength: num(p, "td.setupLength"),
      setupLookback: num(p, "td.setupLookback"),
      countdownLength: num(p, "td.countdownLength"),
      countdownLookback: num(p, "td.countdownLookback"),
    },
    indicators: {
      enabled: new Set(INDICATOR_IDS.filter((id) => p[`ind.on.${id}`] !== false)),
      rsiLow: num(p, "ind.rsiLow"),
      rsiHigh: num(p, "ind.rsiHigh"),
      strongPct: num(p, "ind.strongPct"),
    },
    trend: {
      adxFloor: num(p, "trend.adxFloor"),
      adxSpan: num(p, "trend.adxSpan"),
      diFull: num(p, "trend.diFull"),
      mild: num(p, "trend.mild"),
      strong: num(p, "trend.strong"),
      weights: Object.fromEntries(TREND_VOTERS.map((id) => [id, num(p, `trend.w.${id}`)])),
    },
    structure: { swingAtr: num(p, "structure.swingAtr") },
    defend: { stallBars: num(p, "defend.stallBars"), freshBars: num(p, "defend.freshBars"), reachAtr: num(p, "defend.reachAtr"), minNearAtr: num(p, "defend.minNearAtr") },
    verdict: { trend: w.trend / sum, momentum: w.momentum / sum, position: w.position / sum, timing: w.timing / sum, threshold: num(p, "verdict.threshold"), stopQuantile: num(p, "verdict.stopQuantile"), familyVotes: p["verdict.familyVotes"] === true },
    horizon: Object.fromEntries(TFS.map((tf) => [tf, num(p, `stats.h.${tf}`)])) as Record<Timeframe, number>,
    stats: { minSamples: num(p, "stats.minSamples"), costPct: num(p, "stats.costPct"), alpha: num(p, "stats.alpha") },
  };
}

export const DEFAULT_ENGINE_PARAMS = engineParams();
