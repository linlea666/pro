import { NextResponse } from "next/server";
import { analyzeWith, type Analysis } from "@/lib/analysis";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";
import { currentParams } from "@/lib/server/params-store";
import { DEFAULT_PARAMS, engineParams, validateParams, type ParamValues } from "@/lib/params";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";
import { signalsReport, type ResearchReport } from "@/lib/research/run";

export const dynamic = "force-dynamic";

const COINS = ["BTC", "ETH"];

function digest(a: Analysis) {
  return {
    light: a.verdict.light,
    lightText: a.verdict.lightText,
    score: a.verdict.score,
    trend: `${a.trend.label} ${a.trend.current > 0 ? "+" : ""}${a.trend.current}`,
    supports: a.levels.supports.slice(0, 3).map((l) => Math.round(l.price * 100) / 100),
    resistances: a.levels.resistances.slice(0, 3).map((l) => Math.round(l.price * 100) / 100),
    stats: a.stats.map((s) => ({ key: s.key, name: s.name, samples: s.samples, winRate: s.winRate, baseWinRate: s.baseWinRate, avgReturn: s.avgReturn })),
  };
}
type Digest = ReturnType<typeof digest>;

/** Sample-weighted edge over the random baseline, across all signals. */
function edge(ds: Digest[]) {
  let w = 0, sum = 0;
  for (const d of ds)
    for (const s of d.stats) {
      if (s.winRate == null) continue;
      w += s.samples;
      sum += s.samples * (s.winRate - s.baseWinRate);
    }
  return { samples: w, edge: w ? Math.round((sum / w) * 10) / 10 : 0 };
}

/** Sample-weighted edge (R) of the page's signals, in sample and on the held-out last 12 months. */
function split(r: ResearchReport) {
  const rows = r.rows.filter((x) => x.family === "signal");
  const avg = (k: "is" | "oos") => {
    let w = 0, sum = 0;
    for (const x of rows) {
      const g = x.cells[k];
      if (g.edgeR == null) continue;
      w += g.n;
      sum += g.n * g.edgeR;
    }
    return { samples: w, edgeR: w ? Math.round((sum / w) * 1000) / 1000 : null };
  };
  return { is: avg("is"), oos: avg("oos"), better: rows.filter((x) => x.verdict === "有优势").length, worse: rows.filter((x) => x.verdict === "比随机差").length };
}

/** Trial run: current vs draft parameters on BTC/ETH. Body: { values, tfs?: string[] } */
export const POST = withRoute("admin.params.preview", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { values, tfs } = (await req.json().catch(() => ({}))) as { values?: ParamValues; tfs?: string[] };
  const full = { ...DEFAULT_PARAMS, ...(values ?? {}) };
  const err = validateParams(full);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  const frames = (tfs ?? ["4h", "1d"]).filter((t): t is Timeframe => TIMEFRAMES.includes(t as Timeframe)).slice(0, 3);

  const cur = currentParams().engine;
  const draft = engineParams(full);
  const t0 = Date.now();
  const rows = await Promise.all(
    COINS.flatMap((coin) =>
      frames.map(async (tf) => {
        const [b, a] = await Promise.all([analyzeWith(coin, tf, cur), analyzeWith(coin, tf, draft)]);
        return { coin, tf, before: digest(b), after: digest(a) };
      }),
    ),
  );
  const eb = edge(rows.map((r) => r.before));
  const ea = edge(rows.map((r) => r.after));
  // the same signals over the whole stored history, with the last 12 months held out
  const opts = { paramsVersion: 0, coins: COINS, tfs: frames, indicators: false };
  const [rb, ra] = await Promise.all([signalsReport(cur, opts), signalsReport(draft, opts)]);
  const research = rb.rows.length ? { before: split(rb), after: split(ra), holdoutFrom: rb.holdoutFrom } : null;

  // overfitting heuristics
  const warnings: string[] = [];
  if (ea.edge > eb.edge && ea.samples < eb.samples * 0.7) warnings.push(`胜率优势提高了，但统计样本从 ${eb.samples} 次减少到 ${ea.samples} 次（少了 ${Math.round((1 - ea.samples / Math.max(1, eb.samples)) * 100)}%）。样本越少，结果越可能是运气。`);
  const moved = rows.flatMap((r) => r.after.stats.map((s, k) => ({ s, b: r.before.stats[k] }))).filter(({ s, b }) => s.winRate != null && b.winRate != null && Math.abs(s.winRate - s.baseWinRate - (b.winRate! - b.baseWinRate)) >= 8);
  if (ea.edge - eb.edge >= 2 && moved.length > 0 && moved.length <= 2) warnings.push("整体提升集中在一两个信号上，很可能是针对历史数据“调出来”的，换个时间段未必成立。");
  if (ea.edge - eb.edge >= 5) warnings.push("提升幅度很大。历史数据上调得越好，未来失效的风险通常越高，建议小步调整、观察一段时间。");
  if (research) {
    const d = (x: { edgeR: number | null }, y: { edgeR: number | null }) => (x.edgeR ?? 0) - (y.edgeR ?? 0);
    if (d(research.after.is, research.before.is) > 0.02 && d(research.after.oos, research.before.oos) <= 0)
      warnings.push("样本内变好了，但最近 12 个月的样本外没有变好甚至变差：典型的过拟合迹象。");
  }
  logger.info("audit", "参数试算", { username: admin.username, durationMs: Date.now() - t0, edgeBefore: eb.edge, edgeAfter: ea.edge });
  return NextResponse.json({ rows, summary: { before: eb, after: ea }, research, warnings, durationMs: Date.now() - t0 });
});
