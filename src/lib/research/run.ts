import { PRIMARY_SOURCE, readStored } from "../data/klines.ts";
import type { EngineParams } from "../params.ts";
import { getDb } from "../server/db.ts";
import { COIN_IDS } from "../symbols.ts";
import * as ta from "../ta/core.ts";
import { computeIndicators } from "../ta/indicators.ts";
import { indicatorFlips, signalEvents } from "../ta/signals.ts";
import { computeTd } from "../ta/td.ts";
import { TF_SECONDS, type Candle, type Timeframe } from "../types.ts";
import { bhAdjust, cells, controlTrades, judge, makeSplit, trades, type Cells, type Trade, type Verdict } from "./engine.ts";

/**
 * Research reports on the stored long history (primary source: perpetuals).
 * "signals": every registered signal and every indicator flip; "light": the
 * traffic light itself, from the scorecard's replayed points.
 */

export type ReportKind = "signals" | "light";

export interface ResearchRow {
  family: "signal" | "indicator" | "light";
  key: string;
  name: string;
  side: "bull" | "bear";
  tf: Timeframe;
  horizon: number;
  cells: Cells;
  /** BH-adjusted p-value of the in-sample edge, over the whole report */
  q: number | null;
  consistent: boolean;
  verdict: Verdict;
}

export interface ResearchReport {
  kind: ReportKind;
  title: string;
  createdAt: number;
  source: string;
  paramsVersion: number;
  costPct: number;
  alpha: number;
  holdoutFrom: number;
  coins: string[];
  /** per timeframe: bars per coin and the dates covered */
  coverage: { tf: Timeframe; coins: number; bars: number; from: number | null; to: number | null; holdoutFrom: number }[];
  rows: ResearchRow[];
  notes: string[];
  durationMs: number;
}

/** bars before a signal may be counted: indicators need a warm-up, as on the live page */
const WARMUP = 300;

export function loadHistory(coin: string, tf: Timeframe, nowSec = Date.now() / 1000): Candle[] {
  const sec = TF_SECONDS[tf];
  return readStored(coin, tf, PRIMARY_SOURCE, 1_000_000).filter((x) => x.t + sec <= nowSec);
}

const tick = () => new Promise((r) => setImmediate(r));

function finish(rows: Omit<ResearchRow, "q" | "consistent" | "verdict">[], alpha: number, minSamples: number): ResearchRow[] {
  const q = bhAdjust(rows.map((r) => (r.cells.is.n >= minSamples ? r.cells.is.p : null)));
  return rows.map((r, k) => ({ ...r, q: q[k], ...judge(r.cells, q[k], alpha, minSamples) }));
}

export async function signalsReport(
  ep: EngineParams,
  opts: { paramsVersion: number; coins?: string[]; tfs?: Timeframe[]; nowSec?: number; indicators?: boolean } = { paramsVersion: 0 },
): Promise<ResearchReport> {
  const t0 = Date.now();
  const { coins = COIN_IDS, tfs = ["1h", "4h", "1d"], nowSec = Date.now() / 1000, indicators = true } = opts;
  const cost = ep.stats.costPct;
  const rows: Omit<ResearchRow, "q" | "consistent" | "verdict">[] = [];
  const coverage: ResearchReport["coverage"] = [];
  let holdoutFrom = 0;
  for (const tf of tfs) {
    const H = ep.horizon[tf];
    const sig = new Map<string, { family: ResearchRow["family"]; name: string; side: "bull" | "bear"; list: Trade[] }>();
    const ctl: Record<"bull" | "bear", Trade[]> = { bull: [], bear: [] };
    let bars = 0, n = 0, from: number | null = null, to: number | null = null;
    for (const coin of coins) {
      const c = loadHistory(coin, tf, nowSec);
      if (c.length < WARMUP + 10 * H) continue;
      n++;
      bars += c.length;
      from = Math.min(from ?? Infinity, c[WARMUP].t);
      to = Math.max(to ?? 0, c[c.length - 1].t);
      const panel = computeIndicators(c, undefined, ep.indicators);
      const td = computeTd(c, ep.td);
      const atr = ta.atr(c, 14);
      const add = (family: ResearchRow["family"], key: string, name: string, side: "bull" | "bear", idx: number[]) => {
        const e = sig.get(key) ?? { family, name, side, list: [] };
        e.list.push(...trades(c, atr, idx.filter((i) => i >= WARMUP), side === "bull" ? 1 : -1, H, cost, coin));
        sig.set(key, e);
      };
      for (const d of signalEvents(c, panel, td, ep)) add("signal", d.key, d.name, d.side, d.idx);
      if (indicators) {
        for (const f of indicatorFlips(panel)) {
          add("indicator", `${f.id}:up`, `${f.id} 转多`, "bull", f.up);
          add("indicator", `${f.id}:down`, `${f.id} 转空`, "bear", f.down);
        }
      }
      ctl.bull.push(...controlTrades(c, atr, 1, H, cost, coin, WARMUP));
      ctl.bear.push(...controlTrades(c, atr, -1, H, cost, coin, WARMUP));
      await tick();
    }
    const split = makeSplit(from ?? nowSec, nowSec);
    holdoutFrom = split.holdoutFrom;
    coverage.push({ tf, coins: n, bars: n ? Math.round(bars / n) : 0, from, to, holdoutFrom: split.holdoutFrom });
    for (const [key, e] of sig) if (e.list.length) rows.push({ family: e.family, key, name: e.name, side: e.side, tf, horizon: H, cells: cells(e.list, ctl[e.side], split, H) });
  }
  return {
    kind: "signals",
    title: "信号与指标翻转：前瞻收益对随机",
    createdAt: Date.now(),
    source: PRIMARY_SOURCE,
    paramsVersion: opts.paramsVersion,
    costPct: cost,
    alpha: ep.stats.alpha,
    holdoutFrom,
    coins,
    coverage,
    rows: finish(rows, ep.stats.alpha, ep.stats.minSamples),
    notes: [
      "1R = 入场时的 1 倍 ATR(14)。每笔扣除往返成本；同一币种上相隔不足一个持有期的信号只算一次。",
      "随机对照：同一币种、同一段时间里每一根 K 线都按同方向、同持有期交易一次。",
      "最近 12 个月为样本外，只用来确认；“前半段 / 后半段”和 BTC / ETH 都在样本内统计。",
      "10 个币走势高度相关，合并后的样本数高估了独立证据，结论以 BTC / ETH 分开的结果是否一致为准。",
    ],
    durationMs: Date.now() - t0,
  };
}

export interface LightPoint {
  coin: string;
  tf: Timeframe;
  t: number;
  light: string;
  /** close `horizon` bars later vs. the close at t, % */
  closePct: number;
  /** ATR(14) at t, % of price */
  atrPct: number;
}

/** Green as a long, red as a short, against every point of the same timeframe. */
export function lightRows(points: LightPoint[], ep: EngineParams, nowSec: number) {
  const cost = ep.stats.costPct;
  const rows: Omit<ResearchRow, "q" | "consistent" | "verdict">[] = [];
  const coverage: ResearchReport["coverage"] = [];
  let holdoutFrom = 0;
  for (const tf of ["1h", "4h", "1d"] as Timeframe[]) {
    const pts = points.filter((p) => p.tf === tf).sort((x, y) => x.t - y.t);
    if (!pts.length) continue;
    const trade = (p: LightPoint, dir: 1 | -1): Trade => {
      const pct = p.closePct * dir - cost;
      return { t: p.t, coin: p.coin, pct, r: p.atrPct > 0 ? pct / p.atrPct : 0 };
    };
    const split = makeSplit(pts[0].t, nowSec);
    holdoutFrom = split.holdoutFrom;
    coverage.push({ tf, coins: new Set(pts.map((p) => p.coin)).size, bars: pts.length, from: pts[0].t, to: pts[pts.length - 1].t, holdoutFrom: split.holdoutFrom });
    for (const [light, side, name] of [
      ["green", "bull", "绿灯（按做多算）"],
      ["red", "bear", "红灯（按做空算）"],
    ] as const) {
      const dir = side === "bull" ? 1 : -1;
      // points sit on a grid one horizon apart, so the control does not overlap either
      rows.push({
        family: "light",
        key: `light:${light}`,
        name,
        side,
        tf,
        horizon: ep.horizon[tf],
        cells: cells(pts.filter((p) => p.light === light).map((p) => trade(p, dir)), pts.map((p) => trade(p, dir)), split, 1),
      });
    }
  }
  return { rows: finish(rows, ep.stats.alpha, ep.stats.minSamples), coverage, holdoutFrom };
}

/** The traffic light's record from the scorecard: green as a long, red as a short, against every recorded point. */
export function lightReport(ep: EngineParams, opts: { paramsVersion: number; nowSec?: number } = { paramsVersion: 0 }): ResearchReport {
  const t0 = Date.now();
  const nowSec = opts.nowSec ?? Date.now() / 1000;
  const points = (
    getDb().prepare("SELECT coin, tf, t, light, close_pct, atr_pct FROM scorecard_points").all() as {
      coin: string;
      tf: Timeframe;
      t: number;
      light: string;
      close_pct: number;
      atr_pct: number;
    }[]
  ).map((p): LightPoint => ({ coin: p.coin, tf: p.tf, t: p.t, light: p.light, closePct: p.close_pct, atrPct: p.atr_pct }));
  const { rows, coverage, holdoutFrom } = lightRows(points, ep, nowSec);
  return {
    kind: "light",
    title: "信号灯成绩单：绿灯 / 红灯对随机",
    createdAt: Date.now(),
    source: PRIMARY_SOURCE,
    paramsVersion: opts.paramsVersion,
    costPct: ep.stats.costPct,
    alpha: ep.stats.alpha,
    holdoutFrom,
    coins: [...new Set(points.map((p) => p.coin))],
    coverage,
    rows,
    notes: [
      "数据来自成绩单：在本地全部历史上，每隔一个持有期回放一次信号灯，记录持有期后的涨跌。",
      "随机对照是同一周期全部时点按同方向交易的结果；1R = 当时的 1 倍 ATR(14)。",
      "“比随机差”说明这个灯色在历史上明显站错方向，并不等于反着做就能赚钱：反着做的优势需要单独验证并扣除成本。",
    ],
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------- storage

export function saveReport(r: ResearchReport): number {
  return Number(
    getDb()
      .prepare("INSERT INTO research_reports (created_at, kind, params_version, data) VALUES (?, ?, ?, ?)")
      .run(r.createdAt, r.kind, r.paramsVersion, JSON.stringify(r)).lastInsertRowid,
  );
}

export function listReports(limit = 30) {
  return getDb().prepare("SELECT id, created_at createdAt, kind, params_version paramsVersion FROM research_reports ORDER BY id DESC LIMIT ?").all(limit) as {
    id: number;
    createdAt: number;
    kind: ReportKind;
    paramsVersion: number;
  }[];
}

export function getReport(id?: number, kind?: ReportKind): (ResearchReport & { id: number }) | null {
  const row = (
    id != null
      ? getDb().prepare("SELECT id, data FROM research_reports WHERE id = ?").get(id)
      : getDb().prepare("SELECT id, data FROM research_reports WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind ?? "signals")
  ) as { id: number; data: string } | undefined;
  return row ? { ...(JSON.parse(row.data) as ResearchReport), id: row.id } : null;
}

/** Keep the newest reports of each kind. */
export function pruneReports(keep = 52) {
  getDb().prepare("DELETE FROM research_reports WHERE id NOT IN (SELECT id FROM research_reports r WHERE (SELECT COUNT(*) FROM research_reports x WHERE x.kind = r.kind AND x.id > r.id) < ?)").run(keep);
}
