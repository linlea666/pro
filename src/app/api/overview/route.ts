import { NextResponse } from "next/server";
import { getOverview } from "@/lib/overview";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getOverview(), { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    console.error("[overview]", e);
    return NextResponse.json({ error: "行情数据暂时获取失败，请稍后再试" }, { status: 502 });
  }
}
