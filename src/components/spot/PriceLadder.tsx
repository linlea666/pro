"use client";

import type { SpotPage } from "@/lib/spot/page";
import { Card, fmtUsd, OpinionTag } from "./spot-ui";

interface Item {
  key: string;
  price: number;
  text: string;
  kind: "now" | "calc" | "opinion";
}

const W = 360;
const AXIS = 64;
const LABEL_X = AXIS + 22;
const GAP = 15;
const PAD = 14;

/**
 * ④ Where each ruler's line sits in price, on a log scale and to scale: today's price, the computed lines
 * (from the API's refs) and the opinion zones (bands, in the opinion color). Opinion levels far above the
 * price are listed above the chart instead of squeezing everything else into a sliver.
 */
export function PriceLadder({ d }: { d: SpotPage }) {
  const live = d.live.price;
  const calc = d.refs.filter((r) => r.kind === "calc" && r.price > 0);
  const zones = d.opinion.zones;
  const calcMax = Math.max(live, ...calc.map((r) => r.price));
  const top = Math.max(live * 1.2, calcMax * 1.1);
  const inView = zones.filter((z) => z.priceFrom <= top);
  const above = zones.filter((z) => z.priceFrom > top);
  const lows = [live, ...calc.map((r) => r.price), ...inView.flatMap((z) => [z.priceFrom, z.priceTo]).filter((p) => p > 0)];
  const bottom = Math.min(...lows) * 0.88;

  const items: Item[] = [
    { key: "now", price: live, text: `现价 ${fmtUsd(live)}`, kind: "now" as const },
    ...calc.map((r) => ({ key: r.label, price: r.price, text: `${fmtUsd(r.price)} ${r.label}`, kind: "calc" as const })),
    ...inView.map((z) => {
      const hi = Math.min(z.priceTo, top);
      const lo = Math.max(z.priceFrom, bottom);
      const anchor = z.priceFrom === z.priceTo ? z.priceFrom : z.priceFrom <= bottom ? hi : Math.sqrt(lo * hi);
      const range = z.priceFrom === z.priceTo ? fmtUsd(z.priceFrom) : z.priceFrom === 0 ? `${fmtUsd(z.priceTo)} 以下` : `${fmtUsd(z.priceFrom)}–${fmtUsd(z.priceTo)}`;
      return { key: `op:${z.label}`, price: anchor, text: `“${z.label}” ${range}`, kind: "opinion" as const };
    }),
  ];
  const H = Math.max(460, items.length * 34 + 2 * PAD);
  const ly = (p: number) => PAD + ((Math.log(top) - Math.log(p)) / (Math.log(top) - Math.log(bottom))) * (H - 2 * PAD);

  // labels: sorted top to bottom, pushed apart, then pulled back inside the chart
  const placed = items.map((it) => ({ it, y: ly(it.price), ty: ly(it.price) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < placed.length; i++) placed[i].ty = Math.max(placed[i].ty, placed[i - 1].ty + GAP);
  if (placed.length) placed[placed.length - 1].ty = Math.min(placed[placed.length - 1].ty, H - 6);
  for (let i = placed.length - 2; i >= 0; i--) placed[i].ty = Math.min(placed[i].ty, placed[i + 1].ty - GAP);
  if (placed.length && placed[0].ty < 8) {
    placed[0].ty = 8;
    for (let i = 1; i < placed.length; i++) placed[i].ty = Math.max(placed[i].ty, placed[i - 1].ty + GAP);
  }

  // round-number ticks on the left
  const ticks: number[] = [];
  for (let e = Math.floor(Math.log10(bottom)); e <= Math.ceil(Math.log10(top)); e++)
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= bottom && v <= top) ticks.push(v);
    }
  const color = (k: Item["kind"]) => (k === "now" ? "var(--text)" : k === "opinion" ? "var(--accent)" : "var(--text-2)");

  return (
    <Card title="价格梯：各条线在哪个价格" extra="对数刻度，按比例画">
      {above.length > 0 && (
        <ul className="mb-2 space-y-0.5 text-[12px] text-accent">
          {above.map((z) => (
            <li key={z.label} className="num flex items-center gap-1.5">
              <OpinionTag />
              <span>
                ↑ “{z.label}” {z.priceFrom === z.priceTo ? fmtUsd(z.priceFrom) : `${fmtUsd(z.priceFrom)}–${fmtUsd(z.priceTo)}`}
                <span className="text-ink-3">（在图的上方很远，没有画进来）</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block w-full max-w-[420px]" role="img" aria-label="价格梯">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={AXIS - 4} x2={W} y1={ly(t)} y2={ly(t)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={AXIS - 8} y={ly(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--text-3)" className="num">
              {t >= 1000 ? `${t / 1000}k` : t}
            </text>
          </g>
        ))}
        <line x1={AXIS} x2={AXIS} y1={PAD - 6} y2={H - PAD + 6} stroke="var(--border)" strokeWidth={2} />
        {inView.map((z) => {
          const y1 = ly(Math.min(z.priceTo, top));
          const y2 = z.priceFrom === z.priceTo ? y1 : ly(Math.max(z.priceFrom, bottom));
          return z.priceFrom === z.priceTo ? (
            <line key={z.label} x1={AXIS - 7} x2={AXIS + 7} y1={y1} y2={y1} stroke="var(--accent)" strokeWidth={2} />
          ) : (
            <rect key={z.label} x={AXIS - 7} width={14} y={y1} height={Math.max(2, y2 - y1)} rx={3} fill="var(--accent)" fillOpacity={0.28} stroke="var(--accent)" strokeOpacity={0.6} />
          );
        })}
        {placed.map(({ it, y, ty }) => (
          <g key={it.key}>
            {it.kind === "now" ? (
              <line x1={AXIS - 10} x2={AXIS + 10} y1={y} y2={y} stroke="var(--text)" strokeWidth={2.5} />
            ) : it.kind === "calc" ? (
              <circle cx={AXIS} cy={y} r={3.2} fill="var(--text-2)" />
            ) : null}
            <polyline points={`${AXIS + 9},${y} ${LABEL_X - 5},${ty} ${LABEL_X - 2},${ty}`} fill="none" stroke={color(it.kind)} strokeOpacity={0.5} strokeWidth={1} />
            {it.kind === "opinion" && (
              <>
                <rect x={LABEL_X} y={ty - 6.5} width={24} height={13} rx={2} fill="none" stroke="var(--accent)" strokeWidth={0.8} />
                <text x={LABEL_X + 12} y={ty + 3.5} textAnchor="middle" fontSize={9} fill="var(--accent)">
                  观点
                </text>
              </>
            )}
            <text x={it.kind === "opinion" ? LABEL_X + 29 : LABEL_X} y={ty + 4} fontSize={11.5} fontWeight={it.kind === "now" ? 600 : 400} fill={color(it.kind)} className="num">
              {it.text}
            </text>
          </g>
        ))}
      </svg>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        灰色是按 {d.asOfDay} 的日线算出来的线，蓝色是观点（市值分区按当天流通量换算）。这些线只说明各把尺子在哪个价格，不代表价格会在那里止跌。
      </p>
    </Card>
  );
}
