import { NextResponse, type NextRequest } from "next/server";
import { getKlines } from "@/lib/data/klines";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";
import { getCoin } from "@/lib/symbols";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Recent candles only — used when a chart shows a different timeframe than the analysis. */
export const GET = withRoute("candles", async (req: NextRequest) => {
  const coin = getCoin(req.nextUrl.searchParams.get("coin") ?? "");
  const tf = req.nextUrl.searchParams.get("tf") as Timeframe;
  if (!coin || !TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "unknown coin or timeframe" }, { status: 400 });
  try {
    const { candles } = await getKlines(coin.id, tf);
    return NextResponse.json({ candles: candles.slice(-600) }, { headers: { "cache-control": "public, max-age=15" } });
  } catch (e) {
    logger.error("datasource", "K 线接口失败", { error: e });
    return NextResponse.json({ error: "行情数据暂时获取失败" }, { status: 502 });
  }
});
