import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { ReplayError } from "@/lib/analysis";
import { getWatch, watchAt, watchOverview } from "@/lib/watch";
import { getCoin } from "@/lib/symbols";
import { TF_SECONDS, TIMEFRAMES, type Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Watching key levels. `coin`: one coin's watch (both sides, the levels, the signs, the research); without it,
 * one line per coin. A replay passes the bar picked on the chart: `asOf` (its open time) and `tf` (its timeframe).
 */
async function handler(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const id = q.get("coin");
  const coin = id ? getCoin(id) : null;
  if (id && !coin) return NextResponse.json({ error: "unknown coin" }, { status: 400 });
  const asOf = Number(q.get("asOf"));
  const tf = q.get("tf") as Timeframe;
  const replay = !!coin && asOf > 0 && TIMEFRAMES.includes(tf);
  const over = replay ? limited(req, "replay", getSetting("rate.replayPerMin")) : limited(req, "watch", getSetting("rate.publicPerMin"));
  if (over) return over;
  try {
    if (!coin) return NextResponse.json(await watchOverview(), { headers: { "cache-control": "public, max-age=15" } });
    if (replay) return NextResponse.json(await watchAt(coin.id, asOf + TF_SECONDS[tf]), { headers: { "cache-control": "public, max-age=60" } });
    return NextResponse.json(await getWatch(coin.id), { headers: { "cache-control": "public, max-age=15" } });
  } catch (e) {
    if (e instanceof ReplayError) return NextResponse.json({ error: e.message }, { status: 400 });
    logger.error("engine", "盯盘接口失败", { error: e });
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("watch", handler);
