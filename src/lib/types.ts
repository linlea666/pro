export interface Candle {
  /** open time, unix seconds */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = "15m" | "1h" | "4h" | "1d" | "1w";
export const TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h", "1d", "1w"];

export const TF_SECONDS: Record<Timeframe, number> = {
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

export const TF_LABEL: Record<Timeframe, string> = {
  "15m": "15分钟",
  "1h": "1小时",
  "4h": "4小时",
  "1d": "日线",
  "1w": "周线",
};

/** How beginners should think about each timeframe. */
export const TF_HORIZON: Record<Timeframe, string> = {
  "15m": "超短线（几小时）",
  "1h": "短线（1–3 天）",
  "4h": "波段（几天到两周）",
  "1d": "中线（几周到几个月）",
  "1w": "长线（几个月以上）",
};

export type Bias = "bull" | "bear" | "neutral";

export type Category = "trend" | "momentum" | "volatility" | "volume" | "pattern";

export const CATEGORY_LABEL: Record<Category, string> = {
  trend: "趋势",
  momentum: "动量",
  volatility: "波动",
  volume: "量能",
  pattern: "形态",
};
