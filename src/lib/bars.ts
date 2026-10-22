import { TF_SECONDS, type Timeframe } from "./types.ts";

/**
 * Bar boundaries on the exchange's clock (UTC): every timeframe starts on a multiple of its
 * length since the epoch, except weekly bars, which open on Monday 00:00 UTC.
 */

/** 1970-01-05 00:00 UTC, the first Monday after the epoch */
const WEEK_ANCHOR = 4 * 86400;

/** Open time (unix seconds) of the bar that contains `sec`. */
export function barStart(tf: Timeframe, sec: number): number {
  const len = TF_SECONDS[tf];
  const off = tf === "1w" ? WEEK_ANCHOR : 0;
  return Math.floor((sec - off) / len) * len + off;
}

/** Close time (unix seconds) of the bar that contains `sec`, i.e. the next close after it. */
export const nextClose = (tf: Timeframe, sec: number) => barStart(tf, sec) + TF_SECONDS[tf];

/** True when at least one bar of `tf` closed after `fromMs` and at or before `toMs`. */
export const closedBetween = (tf: Timeframe, fromMs: number, toMs: number) => barStart(tf, Math.floor(toMs / 1000)) > barStart(tf, Math.floor(fromMs / 1000));
