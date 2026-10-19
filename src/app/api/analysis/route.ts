import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { analyze, analyzeAt, ReplayError } from "@/lib/analysis";
import { getCoin } from "@/lib/symbols";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  const coin = getCoin(req.nextUrl.searchParams.get("coin") ?? "");
  const tf = req.nextUrl.searchParams.get("tf") as Timeframe;
  if (!coin || !TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "unknown coin or timeframe" }, { status: 400 });
  const asOf = Number(req.nextUrl.searchParams.get("asOf"));
  // replays are computed on demand and cost far more than the cached live analysis
  const over = asOf > 0 ? limited(req, "replay", getSetting("rate.replayPerMin")) : limited(req, "analysis", getSetting("rate.publicPerMin"));
  if (over) return over;
  try {
    if (asOf > 0) return NextResponse.json(await analyzeAt(coin.id, tf, asOf), { headers: { "cache-control": "public, max-age=60" } });
    return NextResponse.json(await analyze(coin.id, tf), { headers: { "cache-control": "public, max-age=15" } });
  } catch (e) {
    if (e instanceof ReplayError) return NextResponse.json({ error: e.message }, { status: 400 });
    logger.error("engine", "分析接口失败", { error: e });
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("analysis", handler);
