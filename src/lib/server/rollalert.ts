import { getKlines } from "../data/klines.ts";
import { getPerpSnapshot } from "../data/perp.ts";
import { cleanBook, DEFAULT_ROLL_ALERT, holdingView, marketOf, pickRollAlerts, rollMailText, type Market, type RollAlert, type RollBook, type RollMemory } from "../rollbook.ts";
import { getTrendPlan } from "../trendplan.ts";
import { TF_SECONDS } from "../types.ts";
import { coinIds } from "./coins.ts";
import { getDb } from "./db.ts";
import { logger } from "./log.ts";
import { getMailConfig, mailReady, sendMail, type MailConfig } from "./mail.ts";
import { getState, setState } from "./settings.ts";
import { getWatchAlertConfig } from "./watchalert.ts";

/**
 * 滚仓助手 on the server: the admin's accounts and positions (one book, in settings), and the
 * mail alerts. Every minute the server prices each held coin (5-minute bars), takes its 4-hour
 * plan (key levels, ATR, structure stop) and mails what `pickRollAlerts` finds: an add allowed after
 * a 4-hour close beyond a key level, a cut level or a target crossed, close to the stop / past it /
 * close to liquidation, the account's total risk over 6%. The first round only records. Uses the
 * SMTP settings of the system alerts; at most `dailyCap` mails a day (Beijing time).
 */

const KEY = "roll.book";
const EVERY_MS = 60_000;

export function getRollBook(): RollBook {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  const b = row ? (JSON.parse(row.value) as Partial<RollBook>) : {};
  return { accounts: b.accounts ?? [], alert: { ...DEFAULT_ROLL_ALERT, ...b.alert } };
}

const alertMail = (b: RollBook, mail: MailConfig = getMailConfig()): MailConfig => (b.alert.to.length ? { ...mail, to: b.alert.to } : mail);

export function saveRollBook(input: unknown): RollBook {
  const cur = getRollBook();
  const next = cleanBook(input, coinIds());
  const mail = getMailConfig();
  if (next.alert.enabled && !(mail.host && mail.user && mail.passEnc && (next.alert.to.length || mail.to.length))) {
    throw new Error("开启滚仓提醒前，请先在后台“系统设置 → 邮件与告警”里填好 SMTP 服务器、发件邮箱、授权码和收件邮箱");
  }
  // switched (back) on: the first round learns the current state again
  if (next.alert.enabled && !cur.alert.enabled) getDb().prepare("DELETE FROM settings WHERE key = 'state.rollAlert.mem'").run();
  getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify(next), Date.now());
  return next;
}

async function markets(b: RollBook): Promise<Record<string, Market>> {
  const coins = [...new Set(b.accounts.flatMap((a) => a.holdings.map((h) => h.coin)))];
  const out: Record<string, Market> = {};
  for (const coin of coins) {
    try {
      const [m5, plan, perp] = await Promise.all([getKlines(coin, "5m", 50), getTrendPlan(coin, "4h").catch(() => null), getPerpSnapshot(coin).catch(() => null)]);
      out[coin] = marketOf(plan, m5.candles.at(-1)?.c ?? null, perp?.fundingRate ?? null);
      // holdings that confirm adds on a faster close
      const tfs = new Set(b.accounts.flatMap((a) => a.holdings.filter((h) => h.coin === coin && h.confirmTf && h.confirmTf !== "4h").map((h) => h.confirmTf as "1h" | "15m")));
      for (const tf of tfs) {
        const now = Date.now() / 1000;
        const closed = (await getKlines(coin, tf, 10)).candles.filter((x) => x.t + TF_SECONDS[tf] <= now);
        const n = closed.length;
        if (n >= 2) out[coin].closes = { ...out[coin].closes, [tf]: { t: closed[n - 1].t, c: closed[n - 1].c, prev: closed[n - 2].c } };
      }
    } catch (e) {
      logger.warn("engine", `滚仓提醒：${coin} 行情获取失败`, { error: (e as Error).message });
    }
    await new Promise((r) => setImmediate(r));
  }
  return out;
}

const dayOf = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const siteUrl = () => getWatchAlertConfig().siteUrl;

/** One round. Returns what was mailed. */
export async function runRollAlerts(nowMs = Date.now()): Promise<RollAlert[]> {
  const b = getRollBook();
  const mail = alertMail(b);
  if (!b.alert.enabled || !mailReady(mail) || !b.accounts.some((a) => a.holdings.length)) return [];
  const raw = getState("rollAlert.mem");
  const prev = raw ? (JSON.parse(raw) as RollMemory) : null;
  const { alerts, mem } = pickRollAlerts(b, await markets(b), prev ?? {});
  setState("rollAlert.mem", JSON.stringify(mem));
  if (prev == null || !alerts.length) return [];

  const today = dayOf(nowMs);
  const [d, n] = (getState("rollAlert.day") ?? "").split("|");
  const count = d === today ? Number(n) || 0 : 0;
  if (count >= b.alert.dailyCap) {
    logger.info("system", "滚仓提醒已到今天的上限，没有发信", { alerts: alerts.map((a) => a.key), cap: b.alert.dailyCap });
    return [];
  }
  setState("rollAlert.day", `${today}|${count + 1}`);
  const capNote = count + 1 >= b.alert.dailyCap ? `今天的滚仓提醒已到上限 ${b.alert.dailyCap} 封，北京时间明天 0 点前不再发。` : "";
  const { subject, text } = rollMailText(alerts, siteUrl(), capNote);
  await sendMail(subject, text, mail).catch(() => {
    // already logged by sendMail
  });
  return alerts;
}

/** A sample mail with each position's current state, to check the settings end to end. */
export async function sendTestRollAlert(input: unknown): Promise<string[]> {
  const b = cleanBook(input, coinIds());
  const mail = alertMail(b);
  if (!mailReady(mail)) throw new Error("邮件还没有配置完整：请先在后台“系统设置 → 邮件与告警”里填好并保存");
  const ms = await markets(b);
  const lines = ["这是一封测试提醒。正式提醒在可以加仓、到减仓位、到你填的价位、浮盈吐回一半（开了的话）、快到止损、离强平太近、账户总风险超过 6% 时发。", "", "现在的持仓："];
  for (const a of b.accounts)
    for (const h of a.holdings) {
      const m = ms[h.coin];
      const v = m ? holdingView(h, a, m) : null;
      lines.push(`· ${a.name} · ${h.coin} ${h.dir > 0 ? "多单" : "空单"}：${v?.status ? `${v.status.title}。${v.status.detail}` : "行情获取失败"}`);
    }
  if (siteUrl()) lines.push("", `页面：${siteUrl()}/roll`);
  await sendMail("滚仓提醒（测试）", lines.join("\n"), mail);
  return mail.to;
}

const g = globalThis as unknown as { __slRollAlert?: NodeJS.Timeout; __slRollBusy?: boolean };

export function startRollAlerts() {
  if (g.__slRollAlert) return;
  g.__slRollAlert = setInterval(async () => {
    if (g.__slRollBusy) return;
    g.__slRollBusy = true;
    try {
      await runRollAlerts();
    } catch (e) {
      logger.error("system", "滚仓提醒执行失败", { error: e });
    } finally {
      g.__slRollBusy = false;
    }
  }, EVERY_MS);
  g.__slRollAlert.unref?.();
}
