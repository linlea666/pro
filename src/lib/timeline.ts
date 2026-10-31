/**
 * 判断日志（`signallight timeline`）：把一段时间里页面每个时刻会显示的判断按收盘 K 线重算出来，写成一份
 * 可以发给开发者复盘的文本。页面只用已收盘的 K 线，所以重算就是当时页面的内容（和 `plan --at`、
 * `watch --at` 同一套代码）；不同的只有扫损缓冲（回放用默认值）和参数（用现在的参数）。
 *
 * 内容：大趋势（周线 + 日线结构）和各周期结构、50 周均线、行情阶段的每一次变化；实时盯盘每一次“已转强 /
 * 已转弱”，当时的大趋势和之后先到止损还是先到 2R；4 小时计划每一笔已触发的计划和之后的结果；逐时快照。
 * 只描述，不改任何规则。
 */
import type { Candle } from "./types.ts";
import type { TrendPlan } from "./trendplan.ts";
import type { WatchView } from "./watch.ts";
import type { EngineParams } from "./params.ts";

// ---------------------------------------------------------------- pure parts (tested)

/** 大趋势：周线和日线结构给出的方向一致时才算有方向（1 / −1），不一致为 0。 */
export interface BigTrend {
  dir: 1 | -1 | 0;
  week: string;
  day: string;
}

export function bigTrendOf(p: Pick<TrendPlan, "map">): BigTrend | null {
  const w = p.map.find((m) => m.tf === "1w"), d = p.map.find((m) => m.tf === "1d");
  if (!w || !d) return null;
  return { dir: w.direction !== 0 && w.direction === d.direction ? w.direction : 0, week: w.view.label, day: d.view.label };
}

export const BIG_NAME = { 1: "上升", [-1]: "下降", 0: "不一致" } as const;

export function bigTrendText(b: BigTrend | null): string {
  if (!b) return "—";
  return `${BIG_NAME[b.dir]}（周线${b.week}，日线${b.day}）`;
}

/** 一笔交易方向相对大趋势：顺 / 逆 / 中性（大趋势不一致）。 */
export function relation(dir: 1 | -1, big: BigTrend | null): "顺" | "逆" | "中性" {
  if (!big || big.dir === 0) return "中性";
  return big.dir === dir ? "顺" : "逆";
}

export interface HitResult {
  /** stop: 先打到止损（−1R）；target: 先到 r 倍风险；open: 到数据末尾都没分出来 */
  result: "stop" | "target" | "open";
  t: number | null;
  /** 分出结果之前（或到末尾）最远的浮盈，以风险为单位 */
  mfe: number;
}

/**
 * 从开盘时刻 ≥ from 的第一根 K 线起，固定止损对 r 倍风险，哪个先到。同一根两边都碰到算止损（保守）。
 * 只是复盘用的简单算法，不是研究口径（研究扣成本、跟着结构移动认错位）。
 */
export function firstHit(c: Candle[], from: number, dir: 1 | -1, entry: number, stop: number, r = 2): HitResult {
  const risk = Math.abs(entry - stop);
  let mfe = 0;
  if (!(risk > 0)) return { result: "open", t: null, mfe };
  for (const b of c) {
    if (b.t < from) continue;
    if (dir > 0 ? b.l <= stop : b.h >= stop) return { result: "stop", t: b.t, mfe: round2(mfe) };
    const fav = dir > 0 ? (b.h - entry) / risk : (entry - b.l) / risk;
    mfe = Math.max(mfe, fav);
    if (fav >= r) return { result: "target", t: b.t, mfe: round2(mfe) };
  }
  return { result: "open", t: null, mfe: round2(mfe) };
}

export interface Change {
  t: number;
  price: number;
  from: string;
  to: string;
}

/** 一列值依次出现时的每一次变化（第一行不算）。 */
export function changesOf<T>(rows: T[], value: (r: T) => string | null, t: (r: T) => number, price: (r: T) => number): Change[] {
  const out: Change[] = [];
  let prev: string | null = null;
  for (const r of rows) {
    const v = value(r);
    if (v == null) continue;
    if (prev != null && v !== prev) out.push({ t: t(r), price: price(r), from: prev, to: v });
    prev = v;
  }
  return out;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** 北京时间 YYYY-MM-DD HH:MM */
export const bj = (t: number | null | undefined) => (t == null ? "—" : new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " "));
export const fp = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : x >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Math.round(x * 100) / 100));

/** "2026-09-15" / "2026-09-15 20:00"（北京时间，不带时区时）→ Unix 秒 */
export function parseBj(s: string): number {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.trim().replace(" ", "T")}${s.includes(":") ? "" : "T00:00"}+08:00`;
  const t = Date.parse(iso) / 1000;
  if (!Number.isFinite(t)) throw new Error(`看不懂的时间：${s}，例如 "2026-09-15" 或 "2026-09-15 20:00"`);
  return t;
}

const STEPS: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export function parseStep(s: string | undefined): number {
  const v = STEPS[s ?? "4h"];
  if (!v) throw new Error("--step 只能是 15m、1h、4h 或 1d");
  return v;
}

// ---------------------------------------------------------------- the export

export interface Snapshot {
  end: number;
  close: number;
  big: BigTrend | null;
  tfs: Record<string, string>;
  week50: string | null;
  phases: Record<string, string>;
  phaseLine: string | null;
  long: string;
  short: string;
}

export interface TurnRow {
  t: number;
  dir: 1 | -1;
  level: string;
  entry: number;
  stop: number;
  attempt: number;
  big: BigTrend | null;
  hit: HitResult;
}

export interface PlanRow {
  side: "long" | "short";
  headline: string;
  size: "full" | "half";
  entryT: number;
  entry: number;
  stop: number;
  big: BigTrend | null;
  outcome: string;
}

export interface TimelineOptions {
  coin: string;
  from: number;
  to: number;
  step: number;
  ep: EngineParams;
  progress?: (done: number, total: number) => void;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** 逐时刻重算并生成整份文本。 */
export async function buildTimeline(o: TimelineOptions): Promise<string> {
  const { computeTrendPlan } = await import("./trendplan.ts");
  const { computeWatch } = await import("./watch.ts");
  const { seriesAt, cutoff } = await import("./analysis.ts");
  const { weekLineText } = await import("./ta/weekline.ts");
  const { closedThrough } = await import("./data/klines.ts");

  // never past the last closed 15-minute bar
  const latest = closedThrough(await seriesAt(o.coin, "15m", null));
  const to = Math.min(o.to, Math.floor(latest / 900) * 900);
  const from = Math.ceil(o.from / 900) * 900;
  if (!(to > from)) throw new Error("时间段为空：--from 要早于 --to，且不晚于最新收盘");

  const snaps: Snapshot[] = [];
  const turns: TurnRow[] = [];
  const plans: PlanRow[] = [];
  const seenTurn = new Set<string>(), seenPlan = new Set<string>();
  const phaseRows: { end: number; close: number; p1h: string | null; p4h: string | null }[] = [];
  const planAt = new Map<number, TrendPlan>();
  const plan = async (end: number) => {
    // the plan in force at `end`: the one at the close of the last 4-hour bar
    const e4 = Math.floor(end / 14400) * 14400;
    let p = planAt.get(e4);
    if (!p) planAt.set(e4, (p = await computeTrendPlan(o.coin, "4h", o.ep, e4)));
    return p;
  };

  const total = Math.round((to - from) / 900) + 1;
  let done = 0;
  for (let end = from; end <= to; end += 900, done++) {
    if (done % 50 === 0) {
      o.progress?.(done, total);
      await tick();
    }
    let w: WatchView;
    try {
      w = await computeWatch(o.coin, o.ep, end);
    } catch {
      continue;
    }
    const name = (tf: string) => {
      const r = w.phases?.rows.find((x) => x.tf === tf);
      return r ? r.names[r.stage - 1] : null;
    };
    phaseRows.push({ end, close: w.closedPrice, p1h: name("1h"), p4h: name("4h") });

    for (const s of [w.long, w.short]) {
      const ev = s.event;
      if (!ev?.turn) continue;
      const key = `${s.dir}|${ev.startT}|${ev.attempt}`;
      if (seenTurn.has(key)) continue;
      seenTurn.add(key);
      const p = await plan(ev.turn.t + 900);
      turns.push({ t: ev.turn.t, dir: s.dir, level: s.level ? `${s.level.name} ${fp(s.level.price)}` : "—", entry: ev.turn.entry, stop: ev.turn.stop, attempt: ev.attempt, big: bigTrendOf(p), hit: { result: "open", t: null, mfe: 0 } });
    }

    if (end % o.step !== 0 && end !== to) continue;
    const p = await plan(end);
    for (const sp of [p.long, p.short]) {
      if (sp.status !== "active" || sp.entryT == null || sp.entry == null || !sp.invalidation) continue;
      const key = `${sp.side}|${sp.entryT}`;
      if (seenPlan.has(key)) continue;
      seenPlan.add(key);
      const out = p.replay?.[sp.side];
      const res = !out || out.status === "none" ? "—" : out.status === "open" ? `到数据末尾仍持有，${out.r}R` : `${bj(out.exitT)} ${out.exit === "stop" ? "移动认错位离场" : "到期离场"}，${out.r}R（最多浮盈 ${out.mfe}R）`;
      plans.push({ side: sp.side, headline: sp.headline, size: sp.size, entryT: sp.entryT, entry: sp.entry, stop: sp.invalidation.stop, big: bigTrendOf(p), outcome: res });
    }
    snaps.push({
      end,
      close: w.closedPrice,
      big: bigTrendOf(p),
      tfs: Object.fromEntries(p.map.map((m) => [m.tf, m.view.label])),
      week50: p.week50 ? weekLineText(p.week50) : null,
      phases: Object.fromEntries((w.phases?.rows ?? []).map((r) => [r.tf, r.names[r.stage - 1]])),
      phaseLine: w.phases?.headline ?? null,
      long: p.long.headline,
      short: p.short.headline,
    });
  }
  o.progress?.(total, total);

  // outcomes of the turns: the 15-minute bars after each, up to two weeks or the newest close
  for (const r of turns) {
    const horizon = Math.min(r.t + 14 * 86400, latest);
    const c = cutoff((await seriesAt(o.coin, "15m", horizon)).candles, "15m", horizon);
    r.hit = firstHit(c, r.t + 900, r.dir, r.entry, r.stop);
  }

  return formatTimeline(o.coin, from, to, o.step, snaps, phaseRows, turns, plans);
}

const HIT = { stop: "先打到止损（−1R）", target: "先到 +2R", open: "两周内 / 到最新都没分出来" } as const;

export function formatTimeline(
  coin: string,
  from: number,
  to: number,
  step: number,
  snaps: Snapshot[],
  phaseRows: { end: number; close: number; p1h: string | null; p4h: string | null }[],
  turns: TurnRow[],
  plans: PlanRow[],
): string {
  const L: string[] = [];
  const stepName = Object.entries(STEPS).find(([, v]) => v === step)?.[0] ?? `${step}s`;
  L.push(`${coin} 判断日志：${bj(from)} 至 ${bj(to)}（北京时间，时刻 = 那根 K 线收盘的时刻）`);
  L.push(`生成于 ${bj(Math.floor(Date.now() / 1000))}。按收盘 K 线重算，和当时页面同一套代码；扫损缓冲用默认值，参数用现在的参数。快照每 ${stepName} 一行，盯盘事件逐根 15 分钟检查。`);
  L.push(`大趋势 = 周线和日线给出的方向一致时的方向，不一致写“不一致”；方向和计划页的“大周期方向”同一算法（区间被收盘向下脱离也算下降）。只描述，页面目前没有这一行。`);

  // ---- summary
  L.push(`\n========== 一、摘要 ==========`);
  const snapCh = (k: string) => changesOf(snaps, (s) => s.tfs[k] ?? null, (s) => s.end, (s) => s.close);
  const bigCh = changesOf(snaps, (s) => (s.big ? BIG_NAME[s.big.dir] : null), (s) => s.end, (s) => s.close);
  const ph1 = changesOf(phaseRows, (r) => r.p1h, (r) => r.end, (r) => r.close);
  const ph4 = changesOf(phaseRows, (r) => r.p4h, (r) => r.end, (r) => r.close);
  const first = snaps[0], last = snaps.at(-1);
  if (first && last) L.push(`收盘 ${fp(first.close)} → ${fp(last.close)}；大趋势变化 ${bigCh.length} 次，现在${bigTrendText(last.big)}`);
  L.push(`结构变化次数：${["1w", "1d", "4h", "1h"].map((k) => `${k} ${snapCh(k).length}`).join("，")}（按每 ${stepName} 的快照数）；行情阶段变化：1h ${ph1.length}，4h ${ph4.length}（逐根 15 分钟）`);
  const group = (rel: string, d: 1 | -1) => turns.filter((r) => r.dir === d && relation(r.dir, r.big) === rel);
  for (const d of [1, -1] as const) {
    const parts = (["顺", "逆", "中性"] as const).map((rel) => {
      const g = group(rel, d);
      if (!g.length) return null;
      const s = g.filter((x) => x.hit.result === "stop").length, t = g.filter((x) => x.hit.result === "target").length;
      return `${rel}大趋势 ${g.length} 次（先到 2R ${t}、先止损 ${s}，合计 ${t * 2 - s >= 0 ? "+" : ""}${t * 2 - s}R）`;
    }).filter(Boolean);
    L.push(`盯盘${d > 0 ? "做多“已转强”" : "做空“已转弱”"}：${parts.length ? parts.join("；") : "没有"}`);
  }
  L.push(`（盯盘结果按固定止损对 2R 简单算、不扣成本，只说明这一段，不是研究结论。）`);
  L.push(`4 小时计划已触发 ${plans.length} 笔：多 ${plans.filter((x) => x.side === "long").length}、空 ${plans.filter((x) => x.side === "short").length}`);

  // ---- changes
  L.push(`\n========== 二、变化表 ==========`);
  const block = (title: string, ch: Change[]) => {
    L.push(`\n【${title}】${ch.length} 次`);
    for (const x of ch) L.push(`  ${bj(x.t)}  ${fp(x.price).padStart(8)}  ${x.from} → ${x.to}`);
  };
  block("大趋势", bigCh);
  block("周线结构", snapCh("1w"));
  block("日线结构", snapCh("1d"));
  block("50 周均线", changesOf(snaps, (s) => (s.week50 ? s.week50.replace(/第 \d+ 周.*$/, "").replace(/至少 \d+ 周.*$/, "") : null), (s) => s.end, (s) => s.close));
  block("4 小时结构", snapCh("4h"));
  block("4 小时行情阶段", ph4);
  block("1 小时行情阶段", ph1);
  block("1 小时结构", snapCh("1h"));

  // ---- watch turns
  L.push(`\n========== 三、实时盯盘的“已转强 / 已转弱” ==========`);
  L.push(`时刻 | 方向 | 关键位 | 入场 | 止损 | 第几次等待 | 当时大趋势 | 顺逆 | 之后（固定止损对 2R） | 之前最远浮盈`);
  for (const r of turns)
    L.push(`  ${bj(r.t + 900)} | ${r.dir > 0 ? "多 已转强" : "空 已转弱"} | ${r.level} | ${fp(r.entry)} | ${fp(r.stop)} | 第 ${r.attempt} 次 | ${bigTrendText(r.big)} | ${relation(r.dir, r.big)} | ${HIT[r.hit.result]}${r.hit.t ? ` ${bj(r.hit.t)}` : ""} | ${r.hit.mfe}R`);
  if (!turns.length) L.push("  （没有）");

  // ---- plans
  L.push(`\n========== 四、4 小时计划：已触发的计划 ==========`);
  L.push(`入场时刻 | 方向 | 计划 | 仓位 | 入场 | 止损 | 当时大趋势 | 顺逆 | 之后（按页面规则，移动认错位）`);
  for (const x of plans)
    L.push(`  ${bj(x.entryT + 14400)} | ${x.side === "long" ? "多" : "空"} | ${x.headline} | ${x.size === "half" ? "半仓" : "正常"} | ${fp(x.entry)} | ${fp(x.stop)} | ${bigTrendText(x.big)} | ${relation(x.side === "long" ? 1 : -1, x.big)} | ${x.outcome}`);
  if (!plans.length) L.push("  （没有）");

  // ---- snapshots
  L.push(`\n========== 五、逐时快照（每 ${stepName}） ==========`);
  L.push(`时刻 | 收盘 | 大趋势 | 结构 | 50 周均线 | 行情阶段 | 阶段一句话 | 4h 计划：多 ‖ 空`);
  for (const s of snaps)
    L.push(`  ${bj(s.end)} | ${fp(s.close)} | ${s.big ? BIG_NAME[s.big.dir] : "—"} | ${["1w", "1d", "4h", "1h"].map((k) => `${k} ${s.tfs[k] ?? "—"}`).join("；")} | ${s.week50 ?? "—"} | ${["15m", "1h", "4h"].map((k) => `${k} ${s.phases[k] ?? "—"}`).join("；")} | ${s.phaseLine ?? "—"} | ${s.long} ‖ ${s.short}`);
  return L.join("\n") + "\n";
}
