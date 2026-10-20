"use client";

import { useEffect, useRef, useState } from "react";
import type { Timeframe } from "@/lib/types";
import { TF_LABEL } from "@/lib/types";

interface AiContent {
  headline: string;
  summary: string;
  timeframes: string;
  levels: string;
  watch: string[];
  invalidation: string;
  caution: string;
}
type Res =
  | { status: "disabled" | "unsupported" | "none" }
  | { status: "error"; kind: string; message: string }
  | { status: "ok"; content: AiContent; model: string; createdAt: number; barTime: number; cached: boolean; stale?: boolean };

const AI_TFS: Timeframe[] = ["1h", "4h", "1d", "1w"];

const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * AI interpretation card. Shows an interpretation someone already asked for on
 * this closed bar; otherwise waits for the "AI 分析" button, so a page view
 * never costs a model call.
 */
export function AiCard({ coin, tf }: { coin: string; tf: Timeframe }) {
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = AI_TFS.includes(tf);
  // a generation takes 10–40 s; ignore its answer if the visitor has moved to another coin or timeframe
  const current = useRef(`${coin}|${tf}`);
  current.current = `${coin}|${tf}`;
  useEffect(() => {
    let alive = true;
    setRes(null);
    setBusy(false);
    if (!supported) return;
    fetch(`/api/ai?coin=${coin}&tf=${tf}`)
      .then((r) => r.json())
      .then((b) => alive && setRes(b))
      .catch(() => alive && setRes({ status: "none" }));
    return () => {
      alive = false;
    };
  }, [coin, tf, supported]);

  const generate = async () => {
    const key = `${coin}|${tf}`;
    setBusy(true);
    let next: Res;
    try {
      const r = await fetch(`/api/ai?coin=${coin}&tf=${tf}`, { method: "POST" });
      next = await r.json();
    } catch {
      next = { status: "error", kind: "network", message: "网络出错，请稍后再试" };
    }
    if (current.current !== key) return;
    setRes(next);
    setBusy(false);
  };

  if (!supported || !res || res.status === "disabled" || res.status === "unsupported") return null;
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-[#d97757] text-[11px] font-bold text-white">AI</span>
        <h2 className="text-[15px] font-semibold">AI 解读</h2>
        <span className="text-xs text-ink-3">{TF_LABEL[tf]} · 由 Claude 根据上面的数据生成</span>
        {res.status === "ok" && (
          <span className="ml-auto text-[11px] text-ink-3">
            {res.stale ? "今日额度已用完，显示最近一次 · " : ""}生成于 {time(res.createdAt)}
          </span>
        )}
      </div>
      {busy && (
        <div className="space-y-2 px-5 py-4">
          <p className="text-[13px] text-ink-3">AI 正在阅读各项数据并组织语言，通常需要 10–40 秒…</p>
          <div className="h-3 w-3/4 animate-pulse rounded bg-panel-2" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-panel-2" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-panel-2" />
        </div>
      )}
      {!busy && (res.status === "none" || res.status === "error") && (
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <button className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white hover:opacity-90" onClick={generate}>
            AI 分析
          </button>
          <span className="text-[13px] text-ink-3">
            {res.status === "error" ? res.message : "让 AI 用大白话把上面的数据讲一遍。基于最近一根已收盘的 K 线，同一根 K 线所有人共用一份结果。"}
          </span>
        </div>
      )}
      {!busy && res.status === "ok" && (
        <div className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-ink-2">
          <p className="text-[15px] font-semibold text-ink">{res.content.headline}</p>
          <p>{res.content.summary}</p>
          <Row label="多周期">{res.content.timeframes}</Row>
          <Row label="关键位">{res.content.levels}</Row>
          {res.content.watch.length > 0 && (
            <div>
              <b className="text-ink">接下来关注：</b>
              <ul className="mt-1 space-y-1">
                {res.content.watch.map((w) => (
                  <li key={w} className="flex gap-2">
                    <span className="text-ink-3">•</span>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-ink">
            <b className="text-warn">⚠ 认错位：</b>
            {res.content.invalidation}
          </p>
          <Row label="风险提醒">{res.content.caution}</Row>
          <p className="text-[11px] text-ink-3">AI 内容可能出错，只基于本站计算的技术数据，不包含新闻和消息面，不构成投资建议。</p>
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p>
      <b className="text-ink">{label}：</b>
      {children}
    </p>
  );
}
