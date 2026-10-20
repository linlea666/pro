import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { productMetrics } from "@/lib/server/events";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

export const GET = withRoute("admin.metrics", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json(productMetrics());
});
