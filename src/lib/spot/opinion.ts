/**
 * Market-cap zones from someone's public view (not computed from data), shown on the 现货囤币 page as
 * "观点" next to the computed rulers. Stored in the setting `spot.opinionZones` as a JSON string, edited in admin.
 * Pure: shared by the server, the admin API and the page.
 */

import type { CapZone } from "./valuation.ts";

export interface OpinionZones {
  /** whose view, e.g. 推特 @WallStreet0Name */
  source: string;
  /** when it was said, e.g. 2026-10 */
  date: string;
  /** market caps in USD; from = to marks a single level */
  zones: CapZone[];
}

export const DEFAULT_OPINION_ZONES: OpinionZones = {
  source: "推特 @WallStreet0Name",
  date: "2026-10",
  zones: [
    { label: "正常的囤货区", from: 1.2e12, to: 1.5e12 },
    { label: "黑天鹅、恐慌买入区", from: 0, to: 1e12 },
    { label: "下一轮大牛市可能的区间", from: 5e12, to: 5e12 },
    { label: "天花板", from: 1e13, to: 1e13 },
  ],
};

export const OPINION_LIMITS = { maxZones: 8, maxLabel: 20, maxSource: 40, maxDate: 20 } as const;

/** Why a value is not a valid set of zones (Chinese, for the admin page), or null. Accepts the JSON string or the object. */
export function validateOpinionZones(v: unknown): string | null {
  let o: unknown = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      return "观点区间不是有效的 JSON";
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return "观点区间格式不对，需要 { source, date, zones }";
  const x = o as Record<string, unknown>;
  if (typeof x.source !== "string" || !x.source.trim() || x.source.length > OPINION_LIMITS.maxSource) return `来源需要填写，最多 ${OPINION_LIMITS.maxSource} 个字`;
  if (typeof x.date !== "string" || x.date.length > OPINION_LIMITS.maxDate) return `日期最多 ${OPINION_LIMITS.maxDate} 个字`;
  if (!Array.isArray(x.zones) || x.zones.length < 1 || x.zones.length > OPINION_LIMITS.maxZones) return `区间需要 1–${OPINION_LIMITS.maxZones} 个`;
  for (const z of x.zones as unknown[]) {
    if (!z || typeof z !== "object") return "区间格式不对";
    const { label, from, to } = z as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim() || label.length > OPINION_LIMITS.maxLabel) return `每个区间都要有名称，最多 ${OPINION_LIMITS.maxLabel} 个字`;
    if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) return `“${label}”的市值要是不小于 0 的数字（美元）`;
    if (from > to) return `“${label}”的下沿不能高于上沿`;
  }
  return null;
}

/** The stored setting parsed; anything invalid gives the default and `bad: true` (the caller logs it). */
export function parseOpinionZones(v: unknown): { value: OpinionZones; bad: boolean } {
  if (validateOpinionZones(v)) return { value: DEFAULT_OPINION_ZONES, bad: true };
  const o = (typeof v === "string" ? JSON.parse(v) : v) as OpinionZones;
  return {
    value: { source: o.source.trim(), date: o.date, zones: o.zones.map((z) => ({ label: z.label.trim(), from: z.from, to: z.to })) },
    bad: false,
  };
}
