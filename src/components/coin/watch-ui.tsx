import type { WatchStateName } from "@/lib/ta/watch";

/**
 * The watch page's state words, shared by the coin page's "实时盯盘" tab and the /watch overview. Neutral
 * styling on purpose: the state describes where price is in the wait, it is not a buy / sell light.
 */

/** the word for a state on one side (dir 1: longs at a key low; −1: shorts at a key high) */
export function stateWord(state: WatchStateName, dir: 1 | -1 = 1): string {
  switch (state) {
    case "falling":
      return dir > 0 ? "别接" : "别急着空";
    case "watching":
      return "观察";
    case "turned":
      return dir > 0 ? "已转强" : "已转弱";
    case "near":
      return "靠近";
    default:
      return "远离";
  }
}

const ICON: Record<WatchStateName, string> = { falling: "⛔", watching: "👀", turned: "↗", near: "◎", far: "·" };

const TONE: Record<WatchStateName, string> = {
  falling: "border-warn/50 bg-warn-soft text-warn",
  watching: "border-line bg-panel-2 text-ink",
  turned: "border-accent/50 bg-accent-soft text-accent",
  near: "border-line bg-panel-2 text-ink",
  far: "border-line text-ink-3",
};

/** order of urgency: the overview lists coins in this order */
export const STATE_ORDER: WatchStateName[] = ["turned", "falling", "watching", "near", "far"];

export function StatePill({ state, dir = 1, big = false }: { state: WatchStateName; dir?: 1 | -1; big?: boolean }) {
  const icon = state === "turned" && dir < 0 ? "↘" : ICON[state];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-medium ${big ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs"} ${TONE[state]}`}>
      <span aria-hidden="true">{icon}</span>
      {stateWord(state, dir)}
    </span>
  );
}

/** "多：关键低点" / "空：关键高点" */
export const sideName = (dir: 1 | -1) => (dir > 0 ? "多：关键低点" : "空：关键高点");

/** The waiting rule in one line, for the side that matters. */
export const ruleLine = (dir: 1 | -1) =>
  dir > 0
    ? "不在下跌途中猜底：等 15 分钟先走出更高的低点、再收盘站上最近的反弹高点；止损放在最新低点之外。"
    : "不在上涨途中猜顶：等 15 分钟先走出更低的高点、再收盘跌破最近的回落低点；止损放在最新高点之外。";

/** distance in hour ATR with its sign, e.g. "−1.42 倍 ATR" */
export const fmtAtr = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${x < 0 ? "−" : x > 0 ? "+" : ""}${Math.abs(x).toFixed(2)} 倍 ATR`);
