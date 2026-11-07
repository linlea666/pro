"use client";

import { FUNDING_FACT, fundingHeadline, fundingNumbers, type FundingView } from "@/lib/ta/funding";
import { Term } from "../Term";
import type { Mode } from "./CoinView";

const hm = (sec: number) => new Date(sec * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });

/**
 * 资金费率（趋势与计划页签，大趋势卡下面）：谁付谁、付得多不多、拿单每天付 / 收多少。
 * 只描述，不预测方向。文字全部来自 src/lib/ta/funding.ts。
 */
export function FundingLine({ f, mode }: { f: FundingView | null | undefined; mode: Mode }) {
  if (!f) return null;
  const tone = f.crowd ? "border-l-warn" : "border-l-line";
  return (
    <section className={`card border-l-4 ${tone} p-4`} aria-label="资金费率">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 whitespace-nowrap rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-ink-2">
          <Term k="资金费率">资金费率</Term>
        </span>
        <h3 className="text-sm font-semibold">{fundingHeadline(f)}</h3>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{fundingNumbers(f, hm)}</p>
      <p className={`mt-1.5 leading-relaxed text-ink-3 ${mode === "pro" ? "text-[12px]" : "text-[11px]"}`}>{FUNDING_FACT}</p>
    </section>
  );
}
