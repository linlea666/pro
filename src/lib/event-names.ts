/** Product events the browser may send (shared by the tracker and the server). */
export const EVENT_NAMES = {
  first_visit: "首次访问",
  visit: "打开页面",
  view_verdict: "查看结论",
  open_explain: "打开解释",
  click_ai: "点击 AI 分析",
  use_calc: "使用仓位计算",
  use_replay: "使用时光机",
  view_plan: "查看交易计划",
  view_watch: "看实时盯盘",
  view_pa: "看裸 K",
  view_spot: "看现货囤币",
  view_moves: "看涨跌统计",
  view_flows: "看 ETF 买盘",
  view_roll: "看滚仓助手",
  use_roll: "使用滚仓助手",
  use_stack: "使用攒币计划",
  check_position: "使用持仓体检",
  defense_done: "完成防守位任务",
  practice_done: "完成练习",
} as const;

export type EventName = keyof typeof EVENT_NAMES;

/** What the server accepts as a visitor ID. */
export const VISITOR_ID = /^[A-Za-z0-9-]{16,40}$/;

/**
 * A random visitor ID (UUID v4 form). `crypto.randomUUID` exists only on HTTPS or localhost,
 * and the site is served over plain HTTP, so it is built from `getRandomValues`, which works everywhere.
 */
export function newVisitorId(c: Pick<Crypto, "getRandomValues"> = globalThis.crypto): string {
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
