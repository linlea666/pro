"use client";

import { IMPULSE_FACTS, impulseHeadline, quietText, trailText, type Impulse } from "@/lib/ta/impulse";
import type { Mode } from "./CoinView";
import { fmtBjTime } from "./format";

/**
 * 放量冲击提示（E41，实时盯盘页签顶部，大趋势卡下面）：只在冲击还没被 3 倍 1 小时 ATR 吊灯扫掉时显示。
 * 重点是“别逆着做”和“之前 7 天是否已经很动荡”；只描述，不是入场信号。文字全部来自 src/lib/ta/impulse.ts。
 */
export function ImpulseLine({ x, mode }: { x: Impulse | null | undefined; mode: Mode }) {
  if (!x || !x.active) return null;
  const up = x.dir > 0;
  const q = quietText(x);
  const tone = up ? "border-up/60 bg-up-soft text-up" : "border-down/60 bg-down-soft text-down";
  return (
    <section className={`card border-l-4 p-4 ${up ? "border-l-up" : "border-l-down"}`} aria-label="放量冲击">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>放量冲击 {up ? "↑" : "↓"}</span>
        <h3 className="text-sm font-semibold">{impulseHeadline(x).replace(/^放量冲击(向上|向下)：/, "")}</h3>
        <span className="text-[11px] text-ink-3">{fmtBjTime(x.t + 3600)} 收盘 · 只描述，不是入场信号</span>
      </div>
      {q && (
        <p className={`mt-1.5 text-[13px] ${x.quietLabel === "动荡" ? "font-medium text-warn" : "text-ink-2"}`}>
          {q}
          {x.quietLabel === "动荡" ? "：已经很动荡之后的冲击，历史上顺着追反而更差。" : ""}
        </p>
      )}
      <p className="mt-1.5 text-[13px] leading-relaxed">
        <b>别逆着做{up ? "（别摸顶做空）" : "（别接飞刀做多）"}。</b>
        {mode === "pro" ? IMPULSE_FACTS.fade : IMPULSE_FACTS.short.replace(/^放量冲击：/, "")}
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{trailText(x)}</p>
      {mode === "pro" && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          {IMPULSE_FACTS.chase} {IMPULSE_FACTS.what}
        </p>
      )}
    </section>
  );
}
