import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";
import { getParamVersion, listParamVersions, saveParams, currentParams } from "@/lib/server/params-store";
import { DEFAULT_PARAMS, PARAM_MODULES } from "@/lib/params";

/** Roll back by saving a copy of an old version as the newest one. Body: { id } (0 = defaults). */
export const POST = withRoute("admin.params.rollback", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { id } = (await req.json().catch(() => ({}))) as { id?: number };
  const target = id === 0 ? { values: {} } : getParamVersion(Number(id));
  if (!target) return NextResponse.json({ error: "版本不存在" }, { status: 404 });
  const from = currentParams().version;
  const v = saveParams(target.values, admin.username, id === 0 ? "恢复全部默认值" : `回滚到版本 #${id}`);
  logger.info("audit", `参数回滚：新版本 #${v.id}`, { username: admin.username, from, target: id });
  const cur = currentParams();
  return NextResponse.json({ modules: PARAM_MODULES, defaults: DEFAULT_PARAMS, version: cur.version, overrides: cur.values, history: listParamVersions(30) });
});
