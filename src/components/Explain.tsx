"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IndicatorStat } from "@/lib/analysis";
import { getKnowledge } from "@/lib/knowledge";
import { track } from "./track";

/**
 * Tap-to-explain card. Desktop: anchored popover next to the trigger.
 * Phones: bottom sheet. Shows the static explanation plus, when given,
 * what it means right now and how reliable it has been on this coin.
 */

export interface ExplainStats {
  bull?: IndicatorStat;
  bear?: IndicatorStat;
  horizonText: string;
  scope: string;
}

interface Props {
  k: string;
  /** trigger content; defaults to the knowledge title */
  children?: React.ReactNode;
  /** "term" = dashed underline text, "icon" = small ⓘ button, "plain" = children as-is */
  variant?: "term" | "icon" | "plain";
  now?: React.ReactNode;
  stats?: ExplainStats;
  className?: string;
}

const CARD_W = 340;

export function Explain({ k, children, variant = "term", now, stats, className = "" }: Props) {
  const kn = getKnowledge(k);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; mobile: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw < 640) return setPos({ top: 0, left: 0, mobile: true });
    const left = Math.min(Math.max(8, r.left), vw - CARD_W - 8);
    const below = r.bottom + 8;
    const h = card.current?.offsetHeight ?? 260;
    setPos({ top: below + h > vh - 8 ? Math.max(8, r.top - h - 8) : below, left, mobile: false });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);
  // the first placement guesses the card height; correct it once the card is in the DOM
  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);
  const mounted = !!pos;
  useLayoutEffect(() => {
    if (open && mounted) place();
  }, [open, mounted, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!card.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onScroll = () => (window.innerWidth < 640 ? undefined : setOpen(false));
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  if (!kn) return <>{children}</>;

  const triggerCls =
    variant === "icon"
      ? "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line text-[10px] leading-none text-ink-3 hover:border-ink-3 hover:text-ink"
      : variant === "term"
        ? "term"
        : "";

  const body = (
    <>
      <div className="flex items-start gap-2">
        <h3 className="text-sm font-semibold text-ink">{kn.title}</h3>
        <button className="ml-auto text-ink-3 hover:text-ink" onClick={() => setOpen(false)} aria-label="关闭">
          ✕
        </button>
      </div>
      <p className="mt-1 text-[13px] font-medium text-ink">{kn.oneLine}</p>
      {now && (
        <div className="mt-2 rounded-lg bg-accent-soft px-2.5 py-1.5 text-[12px] text-ink">
          <b>此刻：</b>
          {now}
        </div>
      )}
      <p className="mt-2">
        <b className="text-ink">是什么：</b>
        {kn.what}
      </p>
      <p className="mt-1.5">
        <b className="text-ink">怎么用：</b>
        {kn.how}
      </p>
      {kn.trap && (
        <p className="mt-1.5">
          <b className="text-warn">常见误区：</b>
          {kn.trap}
        </p>
      )}
      {stats && (stats.bull || stats.bear) && (
        <div className="mt-2 border-t border-line pt-2">
          <b className="text-ink">在{stats.scope}上灵不灵：</b>
          {stats.bull && <StatLine side="bull" s={stats.bull} horizon={stats.horizonText} />}
          {stats.bear && <StatLine side="bear" s={stats.bear} horizon={stats.horizonText} />}
        </div>
      )}
    </>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${triggerCls} ${className}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) track("open_explain");
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label={variant === "icon" ? `解释：${kn.title}` : undefined}
      >
        {variant === "icon" ? "i" : (children ?? kn.title)}
      </button>
      {open &&
        pos &&
        createPortal(
          pos.mobile ? (
            <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={() => setOpen(false)}>
              <div
                ref={card}
                className="max-h-[75vh] w-full overflow-y-auto rounded-t-2xl border-t border-line bg-panel p-4 pb-8 text-left text-[13px] leading-relaxed text-ink-2"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
              >
                {body}
              </div>
            </div>
          ) : (
            <div
              ref={card}
              role="dialog"
              className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-panel p-3.5 text-left text-[13px] leading-relaxed text-ink-2 shadow-2xl"
              style={{ top: pos.top, left: pos.left, width: CARD_W }}
            >
              {body}
            </div>
          ),
          document.body,
        )}
    </>
  );
}

function StatLine({ side, s, horizon }: { side: "bull" | "bear"; s: IndicatorStat; horizon: string }) {
  const color = s.reliability === "证据较强" ? "var(--up)" : s.reliability === "历史上不利" ? "var(--down)" : s.reliability === "证据弱" ? "var(--warn)" : "var(--text-3)";
  return (
    <p className="mt-1">
      {side === "bull" ? "↑ 转为看多" : "↓ 转为看空"}之后 {horizon}，价格{side === "bull" ? "更高" : "更低"}的比例{" "}
      {s.winRate == null ? (
        "暂无样本"
      ) : (
        <>
          <b className="text-ink">{s.winRate}%</b>（95% 区间 {s.winLo}–{s.winHi}%，随机 {s.baseWinRate}%，{s.samples} 次，已扣成本）
        </>
      )}{" "}
      <b style={{ color }}>{s.reliability}</b>
    </p>
  );
}
