import type { Method } from "@/lib/ta/levels";
import type { KeyLevelKind } from "@/lib/ta/watch";
import type { PaLevel } from "@/lib/ta/patterns";

/**
 * One color per family of level-finding methods, the same on every page (tokens --fam-* in globals.css).
 * Red and green are left to support and resistance.
 */
export type LevelFamily = "swing" | "period" | "pivot" | "fib" | "band" | "avg" | "round";

export const FAMILY_ORDER: LevelFamily[] = ["swing", "period", "pivot", "fib", "band", "avg", "round"];

export const FAMILY_NAME: Record<LevelFamily, string> = {
  swing: "摆动点",
  period: "前期高低",
  pivot: "枢轴",
  fib: "斐波那契",
  band: "通道",
  avg: "均线与成交量",
  round: "整数关口",
};

export const METHOD_FAMILY: Record<Method, LevelFamily> = {
  swing: "swing",
  fractal: "swing",
  prevHL: "period",
  pivot: "pivot",
  camarilla: "pivot",
  fibPivot: "pivot",
  fib: "fib",
  donchian: "band",
  keltner: "band",
  bollinger: "band",
  ma: "avg",
  avwap: "avg",
  volume: "avg",
  round: "round",
};

/** live-watch levels: previous day / week / month, or an intact swing */
export function watchLevelFamily(kind: KeyLevelKind): LevelFamily {
  return kind === "swing1d" || kind === "swing4h" ? "swing" : "period";
}

/** price-action levels: previous day / week / month, or a swing (intact, broken or of a higher timeframe) */
export function paLevelFamily(kind: PaLevel["kind"]): LevelFamily {
  return kind === "period" ? "period" : "swing";
}

export function familyColor(f: LevelFamily): string {
  return `var(--fam-${f})`;
}

export function familyStyle(f: LevelFamily): React.CSSProperties {
  const c = familyColor(f);
  return { color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 12%, transparent)` };
}

/** A colored, non-interactive tag; clickable method tags style themselves with `familyStyle`. */
export function FamilyTag({ family, children, small = false, className = "" }: { family: LevelFamily; children: React.ReactNode; small?: boolean; className?: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded border px-1.5 ${small ? "py-0 text-[10px]" : "py-0.5 text-[11px]"} ${className}`} style={familyStyle(family)}>
      {children}
    </span>
  );
}

/** Legend of the families present, in a fixed order. */
export function FamilyLegend({ families }: { families: Iterable<LevelFamily> }) {
  const set = new Set(families);
  const list = FAMILY_ORDER.filter((f) => set.has(f));
  if (list.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
      {list.map((f) => (
        <span key={f} className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: familyColor(f) }} aria-hidden="true" />
          {FAMILY_NAME[f]}
        </span>
      ))}
    </div>
  );
}
