import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { ReplayError } from "@/lib/analysis";
import { getPa, PA_TFS, paAt, type PaTf } from "@/lib/pa";
import { getCoin } from "@/lib/symbols";
import { TF_SECONDS, TIMEFRAMES, type Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The naked-K page for one coin on one timeframe (`pf`: 15m, 1h, 4h or 1d; default 4h): trend, location, the
 * confirming bar and the research. A replay passes the bar picked on a chart: `asOf` (its open time) and `tf`.
 */
async function handler(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const coin = getCoin(q.get("coin") ?? "");
  if (!coin) return NextResponse.json({ error: "unknown coin" }, { status: 400 });
  const pf = (q.get("pf") ?? "4h") as PaTf;
  if (!PA_TFS.includes(pf)) return NextResponse.json({ error: "unknown pf" }, { status: 400 });
  const asOf = Number(q.get("asOf"));
  const tf = q.get("tf") as Timeframe;
  const replay = asOf > 0 && TIMEFRAMES.includes(tf);
  const over = replay ? limited(req, "replay", getSetting("rate.replayPerMin")) : limited(req, "pa", getSetting("rate.publicPerMin"));
  if (over) return over;
  try {
    if (replay) return NextResponse.json(await paAt(coin.id, pf, asOf + TF_SECONDS[tf]), { headers: { "cache-control": "public, max-age=60" } });
    return NextResponse.json(await getPa(coin.id, pf), { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    if (e instanceof ReplayError) return NextResponse.json({ error: e.message }, { status: 400 });
    logger.error("engine", "裸 K 接口失败", { error: e });
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("pa", handler);
