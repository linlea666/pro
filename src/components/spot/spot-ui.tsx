"use client";

import { useState } from "react";
import type { ZoneLabel } from "@/lib/spot/valuation";

/** Shared bits of the 现货囤币 page: number formats, the zone chip, a collapsible block. */

export type Mode = "beginner" | "pro";

/** Whole dollars with thousands separators; small prices keep their decimals. */
export const fmtUsd = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString("en-US");
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toPrecision(3);
};

export const fmtBtc = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4));

/** 0.4 → "40%" */
export const fmtShare = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** −19.2 → "−19.2%", 3 → "+3%" */
export const fmtSigned = (v: number | null | undefined, d = 1) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : d);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s}%`;
};

export const fmtMult = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} 倍`);

/** "1.67 万亿美元" */
export const fmtCap = (usd: number | null | undefined) => {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd >= 1e12) return `${(usd / 1e12).toFixed(2)} 万亿美元`;
  return `${Math.round(usd / 1e8).toLocaleString("en-US")} 亿美元`;
};

/** "2026-06-05 至 08-16" (the end's year only when it differs) */
export const fmtSpan = (a: string, b: string) => (a === b ? a : `${a} 至 ${a.slice(0, 4) === b.slice(0, 4) ? b.slice(5) : b}`);

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

/** A day count in words a beginner reads easily. */
export const fmtDays = (d: number) => (d < 60 ? `${d} 天` : d < 730 ? `约 ${Math.round(d / 30.4)} 个月` : `约 ${(d / 365).toFixed(1)} 年`);

/** Beijing time of a ms moment: "10-21 16:00" */
export function fmtBj(ms: number) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export const LIVE_SOURCE: Record<string, string> = {
  "binance-futures": "Binance 永续合约",
  "okx-swap": "OKX 永续合约",
  "binance-spot": "Binance 现货",
  local: "本地存储的 1 小时 K 线",
  coinmetrics: "Coin Metrics 日线收盘",
};

/** Low = green, high = red, middle neutral: the site's semantic colors. */
export function ZoneChip({ zone, className = "" }: { zone: ZoneLabel | null | undefined; className?: string }) {
  if (!zone) return <span className={`whitespace-nowrap text-[11px] text-ink-3 ${className}`}>分位未知</span>;
  const style =
    zone === "历史低位"
      ? { color: "var(--up)", background: "var(--up-soft)", borderColor: "var(--up)" }
      : zone === "历史高位"
        ? { color: "var(--down)", background: "var(--down-soft)", borderColor: "var(--down)" }
        : { color: "var(--text-2)", background: "var(--panel-2)", borderColor: "var(--border)" };
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`} style={style}>
      {zone}
    </span>
  );
}

/** The tag every opinion item carries. */
export function OpinionTag() {
  return <span className="inline-flex shrink-0 items-center rounded border border-accent px-1 text-[10px] font-medium leading-4 text-accent">观点</span>;
}

/** A block whose body can be folded; `defaultOpen` follows the mode. */
export function Fold({ summary, children, defaultOpen, label = ["展开", "收起"] }: { summary?: React.ReactNode; children: React.ReactNode; defaultOpen: boolean; label?: [string, string] }) {
  // callers pass key={mode} so a mode switch starts it over
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      {summary}
      <button className="mt-1 text-xs text-accent" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? label[1] : label[0]}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export function Card({ title, extra, children, className = "", id }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`card min-w-0 p-4 ${className}`}>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {extra && <div className="ml-auto text-[11px] text-ink-3">{extra}</div>}
      </div>
      {children}
    </section>
  );
}
