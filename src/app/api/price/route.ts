import { NextResponse, type NextRequest } from "next/server";
import { change24h } from "@/lib/analysis";
import { getKlines } from "@/lib/data/klines";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { findCoin } from "@/lib/server/coins";

export const dynamic = "force-dynamic";

/** Latest traded price and 24-hour change only: the page polls this between closes instead of re-running the analysis. */
export const GET = withRoute("price", async (req: NextRequest) => {
  const over = limited(req, "price", getSetting("rate.publicPerMin"));
  if (over) return over;
  const coin = findCoin(req.nextUrl.searchParams.get("coin") ?? "");
  if (!coin) return NextResponse.json({ error: "unknown coin" }, { status: 400 });
  try {
    const [m5, h1] = await Promise.all([getKlines(coin.id, "5m"), getKlines(coin.id, "1h")]);
    const last = m5.candles[m5.candles.length - 1];
    if (!last) return NextResponse.json({ error: "no data" }, { status: 502 });
    return NextResponse.json(
      // the hourly series' last close is refreshed less often: measure the 24 h change from the 5-minute price
      { price: last.c, change24h: h1.candles.length > 25 ? change24h([...h1.candles.slice(0, -1), { ...h1.candles[h1.candles.length - 1], c: last.c }]) : null, at: m5.fetchedAt },
      { headers: { "cache-control": "public, max-age=10" } },
    );
  } catch (e) {
    logger.error("datasource", "价格接口失败", { error: e });
    return NextResponse.json({ error: "行情数据暂时获取失败" }, { status: 502 });
  }
});
