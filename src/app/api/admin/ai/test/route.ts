import { NextResponse } from "next/server";
import { testConnection, type AiConfigInput } from "@/lib/server/ai";
import { requireAdmin } from "@/lib/server/guard";
import { withRoute } from "@/lib/server/route";

/** Test with the saved config, optionally overriding key / base URL / model from the form. */
export const POST = withRoute("admin.ai.test", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const body = (await req.json().catch(() => ({}))) as AiConfigInput;
  try {
    return NextResponse.json(await testConnection(body));
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message, durationMs: 0 });
  }
});
