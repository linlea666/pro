/** Product events the browser may send (shared by the tracker and the server). */
export const EVENT_NAMES = {
  first_visit: "首次访问",
  visit: "打开页面",
  view_verdict: "查看结论",
  open_explain: "打开解释",
  click_ai: "点击 AI 分析",
  use_calc: "使用仓位计算",
  use_replay: "使用时光机",
  defense_done: "完成防守位任务",
  practice_done: "完成练习",
} as const;

export type EventName = keyof typeof EVENT_NAMES;
