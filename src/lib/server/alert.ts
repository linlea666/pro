import { logger } from "./log.ts";
import { getMailConfig, mailReady, sendMail } from "./mail.ts";
import { getState, setState } from "./settings.ts";

/**
 * System alerts by mail to the administrators. One mail per kind at most every
 * 30 minutes (repeats are counted into the next one), plus a daily digest of
 * everything raised. Raising never throws and never waits for the mail.
 */

export type AlertKind = "datasource" | "gap" | "job" | "ai" | "db";

export const ALERT_LABEL: Record<AlertKind, string> = {
  datasource: "数据源",
  gap: "K 线缺口",
  job: "定时任务 / 预计算",
  ai: "AI 解读",
  db: "数据库容量",
};

const QUIET_MS = 30 * 60 * 1000;
const DIGEST_MAX = 200;

interface DigestEntry {
  at: number;
  kind: AlertKind;
  title: string;
}

function readDigest(): DigestEntry[] {
  try {
    return JSON.parse(getState("alert.digest") || "[]");
  } catch {
    return [];
  }
}

/**
 * Record an alert; mail it unless one of the same kind went out in the last 30 minutes.
 * Returns whether a mail was started (for tests).
 */
export function raiseAlert(kind: AlertKind, title: string, detail: Record<string, unknown> = {}, now = Date.now()): boolean {
  try {
    const digest = readDigest();
    const prev = digest[digest.length - 1];
    // the same problem raised over and over is one line in the digest
    if (!prev || prev.kind !== kind || prev.title !== title || now - prev.at >= QUIET_MS) {
      digest.push({ at: now, kind, title });
      setState("alert.digest", JSON.stringify(digest.slice(-DIGEST_MAX)));
    }

    const c = getMailConfig();
    if (!c.alertsEnabled || !mailReady(c)) return false;
    const last = Number(getState(`alert.last.${kind}`) || 0);
    if (now - last < QUIET_MS) {
      setState(`alert.suppressed.${kind}`, String(Number(getState(`alert.suppressed.${kind}`) || 0) + 1));
      return false;
    }
    const suppressed = Number(getState(`alert.suppressed.${kind}`) || 0);
    setState(`alert.last.${kind}`, String(now));
    setState(`alert.suppressed.${kind}`, "0");
    const lines = [
      title,
      "",
      `类别：${ALERT_LABEL[kind]}`,
      `时间：${new Date(now).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}（北京时间）`,
      ...Object.entries(detail).map(([k, v]) => `${k}：${typeof v === "string" ? v : JSON.stringify(v)}`),
      ...(suppressed ? ["", `上一封之后同类问题又出现了 ${suppressed} 次（30 分钟内同类只发一封）。`] : []),
      "",
      "详细记录见后台“日志中心”；服务器上可运行 sudo signallight diagnose 生成体检报告。",
    ];
    sendMail(`${ALERT_LABEL[kind]}告警：${title}`, lines.join("\n"), c).catch(() => {
      // already logged by sendMail
    });
    return true;
  } catch (e) {
    logger.warn("system", "告警处理失败", { kind, title, error: (e as Error).message });
    return false;
  }
}

/** The day's alerts in one mail (run daily by the job runner); clears the digest. */
export async function sendDigest(extra: string[] = [], now = Date.now()): Promise<boolean> {
  const c = getMailConfig();
  if (!c.alertsEnabled || !mailReady(c)) return false;
  const digest = readDigest().filter((x) => now - x.at < 24 * 3600 * 1000);
  const byKind = new Map<AlertKind, DigestEntry[]>();
  for (const x of digest) byKind.set(x.kind, [...(byKind.get(x.kind) ?? []), x]);
  const lines = [
    digest.length ? `过去 24 小时共 ${digest.length} 条告警：` : "过去 24 小时没有告警。",
    ...[...byKind].flatMap(([kind, list]) => [
      "",
      `【${ALERT_LABEL[kind]}】${list.length} 条，最近一条：${list[list.length - 1].title}`,
    ]),
    ...(extra.length ? ["", "运行概况：", ...extra] : []),
  ];
  await sendMail(digest.length ? `每日摘要：${digest.length} 条告警` : "每日摘要：一切正常", lines.join("\n"), c);
  setState("alert.digest", "[]");
  return true;
}
