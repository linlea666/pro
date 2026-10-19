"use client";

export const fmtDuration = (sec: number) => {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
};

export const fmtTime = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

export function Tile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "up" | "down" | "warn" }) {
  const color = tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : tone === "warn" ? "var(--warn)" : undefined;
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="num mt-1 text-xl font-semibold" style={{ color }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

export const LEVEL_STYLE: Record<string, { color: string; label: string }> = {
  debug: { color: "var(--text-3)", label: "调试" },
  info: { color: "var(--accent)", label: "信息" },
  warn: { color: "var(--warn)", label: "警告" },
  error: { color: "var(--down)", label: "错误" },
};

export const CATEGORY_LABEL: Record<string, string> = {
  datasource: "数据源",
  engine: "分析引擎",
  ai: "AI",
  http: "接口请求",
  audit: "操作审计",
  system: "系统",
  client: "浏览器端",
};

export function LevelBadge({ level }: { level: string }) {
  const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.info;
  return (
    <span className="inline-block whitespace-nowrap rounded border px-1.5 text-[11px] leading-5" style={{ color: s.color, borderColor: s.color }}>
      {s.label}
    </span>
  );
}

export const inputCls = "num w-full rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent";
export const btnCls = "rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50";
export const btnGhost = "rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:text-ink disabled:opacity-50";
