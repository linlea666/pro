import { PA_RULES, type PatternKind } from "@/lib/ta/patterns";

/**
 * The five naked-K patterns for beginners: a small sketch of each (long side; shorts are the mirror image), when it
 * counts, where to buy and where the stop goes — worded from PA_RULES, the rules the detector and the E20 research use.
 */

const R = PA_RULES;

export interface PatternGuide {
  kind: PatternKind;
  /** when the shape counts */
  valid: string;
  /** the buy point */
  entry: string;
  /** the stop and when it is off */
  stop: string;
}

export const PATTERN_GUIDE: PatternGuide[] = [
  {
    kind: "pin",
    valid: `一根 K 线振幅至少 ${R.pinRangeAtr} 倍 ATR，下影线占振幅一半以上，收盘在振幅上方 ${Math.round(R.pinClose * 100)}% 以上，而且最低点是最近 ${R.extremeBars + 1} 根里最低的。`,
    entry: `之后 ${R.confirmBars} 根内，有一根收盘高于这根长影线的最高点。`,
    stop: `长影线最低点之外，再留一段扫损缓冲；确认之前先收盘跌破最低点就作废。`,
  },
  {
    kind: "engulf",
    valid: `一根阴线之后，一根阳线的实体把它的实体整个包住（实体至少 ${R.engulfBodyAtr} 倍 ATR），两根的最低点是最近 ${R.extremeBars + 1} 根里最低的。`,
    entry: `之后 ${R.confirmBars} 根内，有一根收盘高于这两根的最高点。`,
    stop: "两根的最低点之外，再留一段扫损缓冲；确认之前先收盘跌破最低点就作废。",
  },
  {
    kind: "inside",
    valid: `一根振幅至少 ${R.motherAtr} 倍 ATR 的“母线”，之后 1–${R.maxInside} 根 K 线都在它的高低点之内。`,
    entry: `之后 ${R.confirmBars} 根内第一次收盘在母线之外：收在上方做多，收在下方做空。`,
    stop: "母线另一端之外（做多在母线最低点之下），再留一段扫损缓冲。",
  },
  {
    kind: "fake2b",
    valid: `价格第一次跌破最近一个已确认的摆动低点，这根和之后 ${R.reclaimBars} 根内收盘又回到它上方——跌破是假的。`,
    entry: "收盘收回摆动低点上方的那一根。",
    stop: `扫出来的最低点之外，再留一段扫损缓冲；收回之前先收盘跌破 ${R.voidAtr} 倍 ATR 就作废。`,
  },
  {
    kind: "retest",
    valid: `收盘第一次高于最近一个摆动高点 ${R.breakAtr} 倍 ATR（突破），之后 ${R.retestBars} 根内回到它上方 ${R.retestAtr} 倍 ATR 以内（回踩）。`,
    entry: `最近一根回踩 K 线之后 ${R.retestConfirm} 根内，收盘高于这根回踩 K 线的最高点。`,
    stop: `回踩的最低点之外，再留一段扫损缓冲；收盘跌回摆动高点下方 ${R.voidAtr} 倍 ATR 就作废。`,
  },
];

/** a candle in the sketch: x center, open, high, low, close (y down: smaller is higher) */
type Bar = [number, number, number, number, number];

const SKETCH: Record<PatternKind, { bars: Bar[]; lines?: { y: number; dash?: boolean; label: string }[]; mark?: number }> = {
  pin: {
    bars: [[14, 22, 18, 34, 32], [30, 32, 28, 42, 40], [46, 40, 36, 50, 48], [62, 50, 44, 74, 46], [78, 50, 34, 52, 38], [94, 38, 30, 40, 32]],
    mark: 78,
    lines: [{ y: 44, label: "买点" }, { y: 78, dash: true, label: "止损" }],
  },
  engulf: {
    bars: [[14, 24, 20, 36, 34], [30, 34, 30, 46, 44], [46, 46, 44, 62, 60], [62, 61, 36, 64, 40], [78, 40, 30, 42, 32]],
    mark: 78,
    lines: [{ y: 36, label: "买点" }, { y: 68, dash: true, label: "止损" }],
  },
  inside: {
    bars: [[14, 50, 46, 56, 48], [30, 56, 24, 62, 30], [46, 36, 32, 50, 44], [62, 44, 36, 48, 40], [78, 38, 16, 40, 20]],
    mark: 78,
    lines: [{ y: 24, label: "买点" }, { y: 66, dash: true, label: "止损" }],
  },
  fake2b: {
    bars: [[14, 30, 26, 52, 50], [30, 50, 34, 54, 36], [46, 36, 30, 44, 42], [62, 42, 40, 66, 46], [78, 46, 34, 48, 36]],
    mark: 62,
    lines: [{ y: 54, label: "摆动低点" }, { y: 70, dash: true, label: "止损" }],
  },
  retest: {
    bars: [[14, 50, 40, 52, 44], [30, 44, 26, 46, 28], [46, 28, 24, 38, 36], [62, 36, 34, 44, 38], [78, 38, 20, 40, 22]],
    mark: 78,
    lines: [{ y: 36, label: "原阻力" }, { y: 48, dash: true, label: "止损" }],
  },
};

/** A small sketch of one pattern (long side). Colours follow the theme's up / down tokens. */
export function PatternSketch({ kind }: { kind: PatternKind }) {
  const s = SKETCH[kind];
  return (
    <svg viewBox="0 0 130 84" className="h-[84px] w-[130px] shrink-0" role="img" aria-label="形态示意图">
      {s.lines?.map((l) => (
        <g key={l.label}>
          <line x1={4} x2={98} y1={l.y} y2={l.y} stroke={l.dash ? "var(--warn)" : "var(--accent)"} strokeWidth={1} strokeDasharray={l.dash ? "3 2" : undefined} />
          <text x={100} y={l.y + 3} fontSize={8} fill="var(--text-3)">
            {l.label}
          </text>
        </g>
      ))}
      {s.bars.map(([x, o, h, l, c], k) => {
        const up = c < o;
        const col = up ? "var(--up)" : "var(--down)";
        return (
          <g key={k}>
            <line x1={x} x2={x} y1={h} y2={l} stroke={col} strokeWidth={1.2} />
            <rect x={x - 4} y={Math.min(o, c)} width={8} height={Math.max(1.5, Math.abs(c - o))} fill={col} rx={0.5} />
          </g>
        );
      })}
      {s.mark != null && <path d={`M${s.mark - 4} 80 L${s.mark} 75 L${s.mark + 4} 80 Z`} fill="var(--accent)" />}
    </svg>
  );
}
