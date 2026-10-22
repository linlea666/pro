import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { FlowsEmptyError, getFlowsPage } from "@/lib/flows/page";

export const dynamic = "force-dynamic";

/** The ETF 买盘 page: US spot BTC ETF flows, the premarket premium radar and the research facts. */
async function handler(req: NextRequest) {
  const over = limited(req, "flows", getSetting("rate.publicPerMin"));
  if (over) return over;
  try {
    return NextResponse.json(await getFlowsPage(), { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    if (e instanceof FlowsEmptyError) return NextResponse.json({ error: e.message }, { status: 503 });
    logger.error("engine", "ETF 买盘接口失败", { error: e });
    return NextResponse.json({ error: "ETF 买盘暂时无法计算，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("flows", handler);
