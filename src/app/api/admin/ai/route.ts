import { NextResponse } from "next/server";
import { getAiConfig, publicConfig, saveAiConfig, usageReport, type AiConfigInput } from "@/lib/server/ai";
import { canEncrypt } from "@/lib/server/crypto";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const GET = withRoute("admin.ai.get", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json({ config: publicConfig(), usage: usageReport(), canEncrypt: canEncrypt() });
});

export const POST = withRoute("admin.ai.save", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const body = (await req.json().catch(() => ({}))) as AiConfigInput;
  if (body.effort !== undefined && !EFFORTS.includes(body.effort)) return NextResponse.json({ error: "思考强度取值不正确" }, { status: 400 });
  const before = publicConfig(getAiConfig());
  try {
    const after = publicConfig(saveAiConfig(body));
    const changed = (["enabled", "baseUrl", "model", "effort", "dailyLimit", "perIpHourly", "timeoutSec", "fallback"] as const).filter((k) => before[k] !== after[k]);
    logger.info("audit", "修改 AI 配置", {
      username: admin.username,
      changed: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])),
      apiKeyChanged: body.apiKey ? true : body.clearKey ? "cleared" : undefined,
      promptChanged: body.prompt !== undefined && body.prompt !== before.prompt ? true : undefined,
    });
    return NextResponse.json({ config: after, usage: usageReport(), canEncrypt: canEncrypt() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
