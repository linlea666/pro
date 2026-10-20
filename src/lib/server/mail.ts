import { getDb } from "./db.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { logger } from "./log.ts";

/**
 * Outgoing mail (SMTP) for alerts to the administrators. The password
 * (an "授权码" for most mail providers) is stored encrypted and never sent
 * to the browser; leaving it blank on save keeps the stored one.
 */

export type MailSecurity = "ssl" | "starttls" | "none";

export interface MailConfig {
  host: string;
  port: number;
  security: MailSecurity;
  /** sender address, also the login */
  user: string;
  /** AES-GCM blob; never sent to the browser */
  passEnc: string | null;
  /** alert recipients */
  to: string[];
  alertsEnabled: boolean;
}

const DEFAULT_CONFIG: MailConfig = { host: "", port: 465, security: "ssl", user: "", passEnc: null, to: [], alertsEnabled: false };
const CONFIG_KEY = "mail.config";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getMailConfig(): MailConfig {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(CONFIG_KEY) as { value: string } | undefined;
  return { ...DEFAULT_CONFIG, ...(row ? (JSON.parse(row.value) as Partial<MailConfig>) : {}) };
}

export type MailConfigInput = Partial<Omit<MailConfig, "passEnc" | "to">> & { to?: string | string[]; pass?: string; clearPass?: boolean };

/** Merge a form into the stored config and validate it; nothing is saved here. */
export function mergeMailConfig(input: MailConfigInput, cur: MailConfig = getMailConfig()): MailConfig {
  const next: MailConfig = { ...cur };
  if (input.host !== undefined) next.host = String(input.host).trim();
  if (input.port !== undefined) next.port = Math.floor(Number(input.port));
  if (input.security !== undefined) next.security = input.security;
  if (input.user !== undefined) next.user = String(input.user).trim();
  if (input.to !== undefined) {
    const list = Array.isArray(input.to) ? input.to : String(input.to).split(/[\s,;，；]+/);
    next.to = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  }
  if (input.alertsEnabled !== undefined) next.alertsEnabled = Boolean(input.alertsEnabled);
  if (input.clearPass) next.passEnc = null;
  if (input.pass) next.passEnc = encrypt(input.pass.trim());

  if (!["ssl", "starttls", "none"].includes(next.security)) throw new Error("连接方式取值不正确");
  if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw new Error("端口需在 1–65535 之间");
  if (next.host && !/^[A-Za-z0-9.-]+$/.test(next.host)) throw new Error("SMTP 服务器格式不正确，例如 smtp.qq.com");
  if (next.user && !EMAIL.test(next.user)) throw new Error("发件邮箱格式不正确");
  const bad = next.to.find((x) => !EMAIL.test(x));
  if (bad) throw new Error(`收件邮箱格式不正确：${bad}`);
  if (next.to.length > 10) throw new Error("收件邮箱最多 10 个");
  if (next.alertsEnabled && (!next.host || !next.user || !next.passEnc || !next.to.length)) {
    throw new Error("开启告警前，请填好 SMTP 服务器、发件邮箱、授权码和收件邮箱");
  }
  return next;
}

export function saveMailConfig(input: MailConfigInput): MailConfig {
  const next = mergeMailConfig(input);
  getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(CONFIG_KEY, JSON.stringify(next), Date.now());
  return next;
}

/** What the admin page may see: never the password itself. */
export function publicMailConfig(c: MailConfig = getMailConfig()) {
  const { passEnc, ...rest } = c;
  return { ...rest, hasPass: !!passEnc };
}

export function mailReady(c: MailConfig = getMailConfig()) {
  return !!(c.host && c.user && c.passEnc && c.to.length);
}

/** Send one plain-text mail to the configured recipients. Throws with a readable reason. */
export async function sendMail(subject: string, text: string, c: MailConfig = getMailConfig()): Promise<void> {
  if (!mailReady(c)) throw new Error("邮件还没有配置完整");
  const { createTransport } = await import("nodemailer");
  const transport = createTransport({
    host: c.host,
    port: c.port,
    secure: c.security === "ssl",
    requireTLS: c.security === "starttls",
    ignoreTLS: c.security === "none",
    auth: { user: c.user, pass: decrypt(c.passEnc!) },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  const t0 = Date.now();
  try {
    await transport.sendMail({ from: `信号灯 SignalLight <${c.user}>`, to: c.to.join(", "), subject: `[信号灯] ${subject}`, text });
    logger.info("system", `邮件已发送：${subject}`, { to: c.to.length, durationMs: Date.now() - t0 });
  } catch (e) {
    const msg = readable(e as Error & { code?: string; responseCode?: number });
    logger.error("system", `邮件发送失败：${subject}`, { error: msg, host: c.host, port: c.port, durationMs: Date.now() - t0 });
    throw new Error(msg);
  } finally {
    transport.close();
  }
}

function readable(e: Error & { code?: string; responseCode?: number }): string {
  if (e.code === "EAUTH" || e.responseCode === 535) return "登录被拒绝：请检查发件邮箱和授权码（多数邮箱要用授权码，不是登录密码）";
  if (e.code === "ETIMEDOUT" || e.code === "ECONNECTION" || e.code === "ESOCKET") {
    return `连不上 SMTP 服务器（${e.message}）：请检查服务器地址、端口和连接方式；云服务器常封禁 25 端口，建议用 465（SSL）`;
  }
  return e.message;
}
