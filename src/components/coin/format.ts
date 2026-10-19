export const fmtPrice = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (v >= 1) return v.toFixed(v >= 100 ? 2 : 3);
  return v.toPrecision(4);
};

export const fmtPct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);

export const signColor = (v: number) => (v > 0 ? "var(--up)" : v < 0 ? "var(--down)" : "var(--text-3)");

export const biasColor = (b: "bull" | "bear" | "neutral") => (b === "bull" ? "var(--up)" : b === "bear" ? "var(--down)" : "var(--text-3)");
export const biasIcon = (b: "bull" | "bear" | "neutral") => (b === "bull" ? "↑" : b === "bear" ? "↓" : "·");
export const biasText = (b: "bull" | "bear" | "neutral") => (b === "bull" ? "看多" : b === "bear" ? "看空" : "中性");

export function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}
