import { NextResponse, type NextRequest } from "next/server";
import { multiTimeframe } from "@/lib/analysis";
import { getCoin } from "@/lib/symbols";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const coin = getCoin(req.nextUrl.searchParams.get("coin") ?? "");
  if (!coin) return NextResponse.json({ error: "unknown coin" }, { status: 400 });
  try {
    return NextResponse.json(await multiTimeframe(coin.id), { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    console.error("[mtf]", e);
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}
