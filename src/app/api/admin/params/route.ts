import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";
import { currentParams, listParamVersions, saveParams } from "@/lib/server/params-store";
import { DEFAULT_PARAMS, PARAM_DEFS, PARAM_MODULES, diffFromDefaults, resolveParams, validateParams, type ParamValues } from "@/lib/params";

export const dynamic = "force-dynamic";

function state() {
  const cur = currentParams();
  return { modules: PARAM_MODULES, defaults: DEFAULT_PARAMS, version: cur.version, overrides: cur.values, history: listParamVersions(30) };
}

export const GET = withRoute("admin.params.get", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json(state());
});

/** Save a new version. Body: { values: full or partial value set, note?: string } */
export const POST = withRoute("admin.params.save", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { values, note } = (await req.json().catch(() => ({}))) as { values?: ParamValues; note?: string };
  if (!values || typeof values !== "object") return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  const full = { ...DEFAULT_PARAMS, ...values };
  const err = validateParams(full);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const before = resolveParams(currentParams().values);
  const after = resolveParams(diffFromDefaults(full));
  const changes = Object.fromEntries(
    Object.keys(after)
      .filter((k) => before[k] !== after[k])
      .map((k) => [k, { label: PARAM_DEFS.get(k)?.label, from: before[k], to: after[k] }]),
  );
  if (Object.keys(changes).length === 0) return NextResponse.json({ error: "参数没有变化" }, { status: 400 });
  const v = saveParams(full, admin.username, note?.slice(0, 200) || null);
  logger.info("audit", `保存参数版本 #${v.id}`, { username: admin.username, note: v.note, changes });
  return NextResponse.json(state());
});
