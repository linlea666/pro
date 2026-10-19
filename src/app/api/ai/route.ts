import { NextResponse, type NextRequest } from "next/server";
import { AiError, getAiConfig, interpret } from "@/lib/server/ai";
import { withRoute } from "@/lib/server/route";
import { getCoin } from "@/lib/symbols";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

/** AI interpretation for the coin page. Never fails loudly: the card just hides or explains. */
export const GET = withRoute("ai", async (req: NextRequest) => {
  const coin = getCoin(req.nextUrl.searchParams.get("coin") ?? "");
  const tf = req.nextUrl.searchParams.get("tf") as Timeframe;
  if (!coin || !TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "unknown coin or timeframe" }, { status: 400 });
  const c = getAiConfig();
  if (!c.enabled || !c.apiKeyEnc) return NextResponse.json({ status: "disabled" });
  try {
    const r = await interpret(coin.id, tf);
    return NextResponse.json({ status: "ok", ...r });
  } catch (e) {
    const kind = e instanceof AiError ? e.kind : "api";
    // details are in the log center; visitors get a short, friendly message
    const message = kind === "quota" ? (e as Error).message : "AI 解读暂时不可用，稍后会自动重试";
    return NextResponse.json({ status: "error", kind, message });
  }
});
