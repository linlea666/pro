import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";
import { SETTING_DEFAULTS, getSetting, setSetting, type SettingKey } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

/** Validation rules for each editable setting. */
const RULES: Record<SettingKey, (v: unknown) => string | null> = {
  "log.retentionDays": (v) => (Number.isInteger(v) && (v as number) >= 7 && (v as number) <= 365 ? null : "日志保留天数需在 7–365 之间"),
  "log.maxDbMB": (v) => (Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 51200 ? null : "数据库上限需在 100–51200 MB 之间"),
  "log.weeklyArchive": (v) => (typeof v === "boolean" ? null : "取值必须是开或关"),
  "log.archiveKeepWeeks": (v) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 520 ? null : "归档保留周数需在 1–520 之间"),
  "precompute.enabled": (v) => (typeof v === "boolean" ? null : "取值必须是开或关"),
  "backup.keepDaily": (v) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 60 ? null : "备份保留份数需在 1–60 之间"),
};

const all = () => Object.fromEntries((Object.keys(SETTING_DEFAULTS) as SettingKey[]).map((k) => [k, { value: getSetting(k), default: SETTING_DEFAULTS[k] }]));

export const GET = withRoute("admin.settings.get", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json(all());
});

export const POST = withRoute("admin.settings.set", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!(k in RULES)) return NextResponse.json({ error: `未知设置项 ${k}` }, { status: 400 });
    const err = RULES[k as SettingKey](v);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  for (const [k, v] of Object.entries(body)) {
    const from = getSetting(k as SettingKey);
    if (from !== v) {
      setSetting(k as SettingKey, v as never);
      changes[k] = { from, to: v };
    }
  }
  if (Object.keys(changes).length) logger.info("audit", "修改系统设置", { username: admin.username, changes });
  return NextResponse.json(all());
});
