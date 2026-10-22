import { NextResponse, type NextRequest } from "next/server";
import { movesPage, PERIODS, type Period } from "@/lib/moves";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

/** BTC and ETH moves now, ranked against their stored history (the 涨跌统计 page). */
async function handler(req: NextRequest) {
  const over = limited(req, "moves", getSetting("rate.publicPerMin"));
  if (over) return over;
  try {
    const p = req.nextUrl.searchParams.get("period") as Period | null;
    return NextResponse.json(await movesPage(p && PERIODS.includes(p) ? p : "main"), { headers: { "cache-control": "public, max-age=15" } });
  } catch (e) {
    logger.error("engine", "涨跌统计接口失败", { error: e });
    return NextResponse.json({ error: "涨跌统计暂时无法计算，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("moves", handler);
