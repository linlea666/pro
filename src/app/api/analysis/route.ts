import { NextResponse, type NextRequest } from "next/server";
import { analyze } from "@/lib/analysis";
import { getCoin } from "@/lib/symbols";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const coin = getCoin(req.nextUrl.searchParams.get("coin") ?? "");
  const tf = req.nextUrl.searchParams.get("tf") as Timeframe;
  if (!coin || !TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "unknown coin or timeframe" }, { status: 400 });
  try {
    return NextResponse.json(await analyze(coin.id, tf), { headers: { "cache-control": "public, max-age=15" } });
  } catch (e) {
    console.error("[analysis]", e);
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}
