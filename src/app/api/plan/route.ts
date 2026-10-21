import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { ReplayError } from "@/lib/analysis";
import { FRAMEWORKS, getTrendPlan, trendPlanAt, type Framework } from "@/lib/trendplan";
import { findCoin } from "@/lib/server/coins";
import { TF_SECONDS, TIMEFRAMES, type Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Trend map and trading plans. `fw`: 4h (daily direction, 4-hour entries; the default) or 1d.
 * A replay passes the bar picked on the chart: `asOf` (its open time) and `tf` (its timeframe).
 */
async function handler(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const coin = findCoin(q.get("coin") ?? "");
  const fw = (q.get("fw") ?? "4h") as Framework;
  if (!coin || !(fw in FRAMEWORKS)) return NextResponse.json({ error: "unknown coin or framework" }, { status: 400 });
  const asOf = Number(q.get("asOf"));
  const tf = q.get("tf") as Timeframe;
  const replay = asOf > 0 && TIMEFRAMES.includes(tf);
  const over = replay ? limited(req, "replay", getSetting("rate.replayPerMin")) : limited(req, "plan", getSetting("rate.publicPerMin"));
  if (over) return over;
  try {
    if (replay) return NextResponse.json(await trendPlanAt(coin.id, fw, asOf + TF_SECONDS[tf]), { headers: { "cache-control": "public, max-age=60" } });
    return NextResponse.json(await getTrendPlan(coin.id, fw), { headers: { "cache-control": "public, max-age=15" } });
  } catch (e) {
    if (e instanceof ReplayError) return NextResponse.json({ error: e.message }, { status: 400 });
    logger.error("engine", "交易计划接口失败", { error: e });
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("plan", handler);
