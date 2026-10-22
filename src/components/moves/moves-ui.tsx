"use client";

import type { MoveBand } from "@/lib/ta/moves";

export type Mode = "beginner" | "pro";

const BAND_CLASS: Record<MoveBand, string> = {
  平常: "bg-panel-2 text-ink-3",
  偏大: "bg-panel-2 text-ink-2",
  大: "bg-warn-soft text-ink",
  很大: "bg-warn-soft text-ink font-medium",
  极端: "bg-ink text-bg font-medium",
};

export const day = (t: number | null | undefined) => (t == null ? "—" : new Date(t * 1000).toISOString().slice(0, 10));
export const signed = (x: number | null | undefined, d = 2) => (x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}%`);
export const tone = (x: number | null | undefined) => (x == null || x === 0 ? "" : x < 0 ? "text-down" : "text-up");
export const price = (x: number | null) => (x == null ? "—" : x >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2));

/** "约每 5 天一次", from seconds per occurrence. */
export function every(sec: number | null | undefined): string {
  if (sec == null) return "没出现过";
  const h = sec / 3600;
  if (h < 1.5) return "约每小时一次";
  if (h < 36) return `约每 ${Math.round(h)} 小时一次`;
  const d = h / 24;
  if (d < 1.5) return "约每天一次";
  if (d < 60) return `约每 ${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)} 天一次`;
  if (d < 365) return `约每 ${Math.round(d / 30)} 个月一次`;
  return `约每 ${Math.round((d / 365) * 10) / 10} 年一次`;
}

export function Band({ b }: { b: MoveBand | null }) {
  if (!b) return null;
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${BAND_CLASS[b]}`}>{b}</span>;
}

export function Card({ title, extra, children }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card min-w-0 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {extra && <div className="ml-auto text-[12px] text-ink-3">{extra}</div>}
      </div>
      {children}
    </section>
  );
}

