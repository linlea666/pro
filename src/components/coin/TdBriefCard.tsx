"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { Analysis, LightSummary } from "@/lib/analysis";
import { tdBrief, tdDetailOf, type TdBriefRow } from "@/lib/tdbrief";
import { TF_LABEL, TF_SECONDS, type Timeframe } from "@/lib/types";
import { track } from "../track";

interface TdAiContent {
  conclusion: string;
  timeframes: string;
  review: string;
  watch: string[];
}
type AiRes =
  | { status: "disabled" | "unsupported" | "none" }
  | { status: "error"; kind: string; message: string }
  | { status: "ok"; content: TdAiContent; createdAt: number; stale?: boolean };

const AI_TFS: Timeframe[] = ["1h", "4h", "1d", "1w"];

const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * TD 解读：规则模板把多周期计数写成人话（新手看结论和提醒，专业模式看全部四段）。
 * 专业模式在 1 小时及以上周期另有 AI 按钮，同一根收盘 K 线共用一份，含预测性说法的会被丢弃。
 */
export function TdBriefCard({ a, mtf, mode }: { a: Analysis; mtf: LightSummary[] | null; mode: "beginner" | "pro" }) {
  const brief = useMemo(() => {
    const closed = a.forming ? a.candles.slice(0, -1) : a.candles;
    const focus: TdBriefRow = { tf: a.tf, d: tdDetailOf(a.td, closed) };
    const focusCloseAt = a.lastClosedT + TF_SECONDS[a.tf];
    // a replay has no multi-timeframe data: describe the rewound timeframe only; otherwise take whichever copy of the focus timeframe saw the later close
    // big to small, as in the multi-timeframe table
    const rows: TdBriefRow[] = mtf && !a.replay ? [...mtf].reverse().map((m) => (m.tf === a.tf && m.closeAt <= focusCloseAt ? focus : { tf: m.tf, d: m.tdDetail })) : [focus];
    if (!rows.some((r) => r.tf === a.tf)) rows.push(focus);
    const ls = a.td.current.lastSignal;
    const last = ls ? { side: ls.side, kind: ls.kind, barsAgo: ls.barsAgo, price: ls.price, riskLevel: ls.riskLevel, invalidated: ls.invalidated, changePct: ls.changePct } : null;
    return tdBrief(rows, a.tf, last, a.stats);
  }, [a, mtf]);
  const pro = mode === "pro";

  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">TD 解读</h2>
        <span className="text-xs text-ink-3">{TF_LABEL[a.tf]} · 按已收盘的 K 线</span>
      </div>
      <div className="space-y-2.5 text-[13px] leading-relaxed text-ink-2">
        <p className="text-[14px] font-medium text-ink">{brief.conclusion}</p>
        {pro && (
          <Block label="多周期">
            <ul className="space-y-0.5">
              {brief.timeframes.map((t) => (
                <li key={t.tf}>
                  <span className={t.tf === a.tf ? "font-medium text-ink" : "text-ink"}>{TF_LABEL[t.tf]}</span>：{t.text}
                </li>
              ))}
            </ul>
            {brief.alignment && <p className="mt-1">{brief.alignment}</p>}
          </Block>
        )}
        {pro && (
          <Block label="复盘">
            {brief.review.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </Block>
        )}
        <Block label="接下来盯">
          <ul className="space-y-0.5">
            {brief.watch.map((w) => (
              <li key={w} className="flex gap-2">
                <span className="text-ink-3">•</span>
                {w}
              </li>
            ))}
          </ul>
        </Block>
        <p className="rounded-lg bg-panel-2 px-3 py-2 text-xs">{brief.research}</p>
      </div>
      {pro && !a.replay && AI_TFS.includes(a.tf) && <TdAi coin={a.coin} tf={a.tf} />}
    </section>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <b className="text-ink">{label}：</b>
      {children}
    </div>
  );
}

function TdAi({ coin, tf }: { coin: string; tf: Timeframe }) {
  const [res, setRes] = useState<AiRes | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef(`${coin}|${tf}`);
  current.current = `${coin}|${tf}`;
  useEffect(() => {
    let alive = true;
    setRes(null);
    setBusy(false);
    fetch(`/api/ai?kind=td&coin=${coin}&tf=${tf}`)
      .then((r) => r.json())
      .then((b) => alive && setRes(b))
      .catch(() => alive && setRes({ status: "none" }));
    return () => {
      alive = false;
    };
  }, [coin, tf]);

  const generate = async () => {
    const key = `${coin}|${tf}`;
    track("click_ai");
    setBusy(true);
    let next: AiRes;
    try {
      next = await (await fetch(`/api/ai?kind=td&coin=${coin}&tf=${tf}`, { method: "POST" })).json();
    } catch {
      next = { status: "error", kind: "network", message: "网络出错，请稍后再试" };
    }
    if (current.current !== key) return;
    setRes(next);
    setBusy(false);
  };

  if (!res || res.status === "disabled" || res.status === "unsupported") return null;
  return (
    <div className="mt-3 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-[#d97757] text-[10px] font-bold text-white">AI</span>
        <b className="text-ink">交易员口吻的解读</b>
        {res.status === "ok" && (
          <span className="ml-auto text-[11px] text-ink-3">
            {res.stale ? "今日额度已用完，显示最近一次 · " : ""}生成于 {time(res.createdAt)}
          </span>
        )}
      </div>
      {busy ? (
        <p className="text-ink-3">AI 正在阅读各周期的计数，通常需要 10–40 秒…</p>
      ) : res.status === "ok" ? (
        <div className="space-y-2">
          <p className="font-medium text-ink">{res.content.conclusion}</p>
          <Block label="多周期">
            <span className="whitespace-pre-line">{res.content.timeframes}</span>
          </Block>
          <Block label="复盘">
            <span className="whitespace-pre-line">{res.content.review}</span>
          </Block>
          <Block label="接下来盯">
            <ul className="space-y-0.5">
              {res.content.watch.map((w) => (
                <li key={w} className="flex gap-2">
                  <span className="text-ink-3">•</span>
                  {w}
                </li>
              ))}
            </ul>
          </Block>
          <p className="text-[11px] text-ink-3">AI 只根据上面的计数改写，可能出错；说出预测涨跌的话会被系统丢弃。不构成投资建议。</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90" onClick={generate}>
            AI 解读
          </button>
          <span className="text-ink-3">
            {res.status === "error"
              ? `${res.message}${res.kind === "bad_output" ? "，请以上面的规则解读为准。" : ""}`
              : "让 AI 用交易员的口吻把上面的计数讲一遍，同一根 K 线所有人共用一份。"}
          </span>
        </div>
      )}
    </div>
  );
}
