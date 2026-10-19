import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";
import { multiTimeframe } from "@/lib/analysis";
import { getCoin } from "@/lib/symbols";

export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  const coin = getCoin(req.nextUrl.searchParams.get("coin") ?? "");
  if (!coin) return NextResponse.json({ error: "unknown coin" }, { status: 400 });
  try {
    return NextResponse.json(await multiTimeframe(coin.id), { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    logger.error("engine", "多周期接口失败", { error: e });
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}

export const GET = withRoute("mtf", handler);
