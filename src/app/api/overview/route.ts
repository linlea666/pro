import { NextResponse } from "next/server";
import { logger } from "@/lib/server/log";
import { limited, withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { getOverview } from "@/lib/overview";

export const dynamic = "force-dynamic";

async function handler(req: Request) {
  const over = limited(req, "overview", getSetting("rate.publicPerMin"));
  if (over) return over;
  try {
    return NextResponse.json(await getOverview(), { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    logger.error("engine", "总览接口失败", { error: e });
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("overview", handler);
