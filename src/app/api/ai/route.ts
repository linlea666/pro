import { NextResponse, type NextRequest } from "next/server";
import { AI_TFS, AiError, getAiConfig, interpret, peekInterpretation } from "@/lib/server/ai";
import { limited, withRoute } from "@/lib/server/route";
import { getCoin } from "@/lib/symbols";
import type { Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

function parse(req: NextRequest) {
  const coin = getCoin(req.nextUrl.searchParams.get("coin") ?? "");
  const tf = req.nextUrl.searchParams.get("tf") as Timeframe;
  return coin && AI_TFS.includes(tf) ? { coin: coin.id, tf } : null;
}

/** Cached interpretation for the last closed bar, if any. Never calls the model. */
export const GET = withRoute("ai", async (req: NextRequest) => {
  const p = parse(req);
  if (!p) return NextResponse.json({ status: "unsupported" });
  const c = getAiConfig();
  if (!c.enabled || !c.apiKeyEnc) return NextResponse.json({ status: "disabled" });
  const r = await peekInterpretation(p.coin, p.tf);
  return NextResponse.json(r ? { status: "ok", ...r } : { status: "none" });
});

/** Generate on request (the "AI 分析" button). Never fails loudly: the card just explains. */
export const POST = withRoute("ai.generate", async (req: NextRequest) => {
  const p = parse(req);
  if (!p) return NextResponse.json({ error: "这个周期不提供 AI 分析" }, { status: 400 });
  const c = getAiConfig();
  if (!c.enabled || !c.apiKeyEnc) return NextResponse.json({ status: "disabled" });
  const hit = await peekInterpretation(p.coin, p.tf);
  if (hit) return NextResponse.json({ status: "ok", ...hit });
  // only real generations count towards the per-IP limit
  const blocked = limited(req, "ai", c.perIpHourly, 3600_000);
  if (blocked) return NextResponse.json({ status: "error", kind: "rate", message: `每小时最多生成 ${c.perIpHourly} 次，请稍后再试，或先看看其他已生成的周期` });
  try {
    const r = await interpret(p.coin, p.tf);
    return NextResponse.json({ status: "ok", ...r });
  } catch (e) {
    const kind = e instanceof AiError ? e.kind : "api";
    // details are in the log center; visitors get a short, friendly message
    const message = kind === "quota" ? (e as Error).message : "AI 分析暂时不可用，请稍后再试";
    return NextResponse.json({ status: "error", kind, message });
  }
});
