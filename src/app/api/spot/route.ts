import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { getSpotPage, SpotEmptyError } from "@/lib/spot/page";

export const dynamic = "force-dynamic";

/** BTC spot valuation for the 现货囤币 page (daily rulers, episodes, Fear & Greed, history for the planner's replay). */
async function handler(req: NextRequest) {
  const over = limited(req, "spot", getSetting("rate.publicPerMin"));
  if (over) return over;
  try {
    return NextResponse.json(await getSpotPage(), { headers: { "cache-control": "public, max-age=60" } });
  } catch (e) {
    if (e instanceof SpotEmptyError) return NextResponse.json({ error: e.message }, { status: 503 });
    logger.error("engine", "现货囤币接口失败", { error: e });
    return NextResponse.json({ error: "现货估值暂时无法计算，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("spot", handler);
