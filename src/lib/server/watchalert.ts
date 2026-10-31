import { fmtPrice, getWatch, type WatchView } from "../watch.ts";
import { againstBig, BIG_TREND_FACTS, bigTrendRows, type BigTrend } from "../ta/bigtrend.ts";
import type { WatchSide } from "../ta/watch.ts";
import { getDb } from "./db.ts";
import { coinIds } from "./coins.ts";
import { logger } from "./log.ts";
import { getMailConfig, mailReady, sendMail, type MailConfig } from "./mail.ts";
import { getState, setState } from "./settings.ts";

/**
 * Watch alerts by mail: after every 15-minute close the server works out each shown coin's
 * watch (the same `getWatch` the page uses) and mails a turn ("已转强 / 已转弱"), and, when
 * switched on, a fresh "别接" (touched or through a key level). One mail per event and attempt,
 * every coin of one close in one mail, at most `dailyCap` mails a day (Beijing time). The very
 * first run only records what is already going on. Uses the SMTP settings of the system alerts.
 */

export interface WatchAlertConfig {
  enabled: boolean;
  /** coins to watch; empty: every coin shown on the site */
  coins: string[];
  turned: boolean;
  falling: boolean;
  /** recipients; empty: the system-alert recipients */
  to: string[];
  dailyCap: number;
  /** e.g. http://1.2.3.4:3000, for a link back to the page (optional) */
  siteUrl: string;
}

export const DEFAULT_WATCH_ALERT: WatchAlertConfig = { enabled: false, coins: [], turned: true, falling: false, to: [], dailyCap: 20, siteUrl: "" };
const CONFIG_KEY = "watch.alertConfig";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BAR = 900;
/** a turn older than this (the server was down, say) is not news any more */
const STALE_SEC = 3600;
/** seen keys are kept this long (an event lasts at most 3 days) */
const SEEN_KEEP_SEC = 5 * 86400;

export function getWatchAlertConfig(): WatchAlertConfig {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(CONFIG_KEY) as { value: string } | undefined;
  return { ...DEFAULT_WATCH_ALERT, ...(row ? (JSON.parse(row.value) as Partial<WatchAlertConfig>) : {}) };
}

export type WatchAlertInput = Partial<Omit<WatchAlertConfig, "coins" | "to">> & { coins?: string | string[]; to?: string | string[] };

const list = (x: string | string[]) => [...new Set((Array.isArray(x) ? x : String(x).split(/[\s,;，；、]+/)).map((s) => String(s).trim()).filter(Boolean))];

/** Merge a form into the stored config and validate it; nothing is saved here. */
export function mergeWatchAlertConfig(input: WatchAlertInput, cur: WatchAlertConfig = getWatchAlertConfig(), mail: MailConfig = getMailConfig()): WatchAlertConfig {
  const next: WatchAlertConfig = { ...cur };
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.turned !== undefined) next.turned = Boolean(input.turned);
  if (input.falling !== undefined) next.falling = Boolean(input.falling);
  if (input.coins !== undefined) next.coins = list(input.coins).map((x) => x.toUpperCase());
  if (input.to !== undefined) next.to = list(input.to);
  if (input.dailyCap !== undefined) next.dailyCap = Math.floor(Number(input.dailyCap));
  if (input.siteUrl !== undefined) next.siteUrl = String(input.siteUrl).trim().replace(/\/+$/, "");

  const bad = next.to.find((x) => !EMAIL.test(x));
  if (bad) throw new Error(`收件邮箱格式不正确：${bad}`);
  if (next.to.length > 10) throw new Error("收件邮箱最多 10 个");
  if (!Number.isInteger(next.dailyCap) || next.dailyCap < 1 || next.dailyCap > 200) throw new Error("每天最多封数需在 1–200 之间");
  if (next.siteUrl && !/^https?:\/\/[^\s/]+$/.test(next.siteUrl)) throw new Error("网站地址格式不正确，例如 http://1.2.3.4:3000");
  if (next.enabled && !next.turned && !next.falling) throw new Error("至少选一种要提醒的情况");
  if (next.enabled && !(mail.host && mail.user && mail.passEnc && (next.to.length || mail.to.length))) {
    throw new Error("开启盯盘提醒前，请先在上面的“邮件与告警”里填好 SMTP 服务器、发件邮箱、授权码，并填写收件邮箱");
  }
  return next;
}

export function saveWatchAlertConfig(input: WatchAlertInput): WatchAlertConfig {
  const cur = getWatchAlertConfig();
  const next = mergeWatchAlertConfig(input, cur);
  // switched (back) on: the first round learns again what is already going on
  if (next.enabled && !cur.enabled) getDb().prepare("DELETE FROM settings WHERE key = 'state.watchAlert.seen'").run();
  getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(CONFIG_KEY, JSON.stringify(next), Date.now());
  return next;
}

/** The mail settings with this alert's recipients (if any). */
export const alertMail = (cfg: WatchAlertConfig, mail: MailConfig = getMailConfig()): MailConfig => (cfg.to.length ? { ...mail, to: cfg.to } : mail);

// ---------------------------------------------------------------- what is new

export interface WatchAlert {
  key: string;
  coin: string;
  kind: "turned" | "falling";
  side: WatchSide;
  /** the research sentence of the page, when there is a report */
  research: string | null;
  /** 周线、日线的大趋势（只描述），没有时省略 */
  big?: BigTrend | null;
}

/** One key per event, state and attempt: a turn undone by a new extreme and made again is a new one. */
export const alertKey = (coin: string, s: WatchSide) => `${coin}:${s.dir}:${s.event!.startT}:${s.state}:${s.event!.attempt}`;

/** The alerts in `views` not in `seen`; `nowSec` is the latest close (turns older than an hour are left out). */
export function pickAlerts(views: WatchView[], cfg: Pick<WatchAlertConfig, "turned" | "falling">, seen: Record<string, number>, nowSec: number): WatchAlert[] {
  const out: WatchAlert[] = [];
  for (const v of views) {
    for (const s of [v.long, v.short]) {
      if (!s.event) continue;
      const kind = s.state === "turned" ? "turned" : s.state === "falling" ? "falling" : null;
      if (!kind || !cfg[kind]) continue;
      if (kind === "turned" && (!s.event.turn || nowSec - (s.event.turn.t + BAR) > STALE_SEC)) continue;
      const key = alertKey(v.coin, s);
      if (seen[key]) continue;
      out.push({ key, coin: v.coin, kind, side: s, research: v.research?.text ?? null, big: v.big ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the mail

const bj = (sec: number) => new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function alertTitle(a: WatchAlert): string {
  const long = a.side.dir > 0;
  if (a.kind === "turned") return `${a.coin} 已转${long ? "强" : "弱"}`;
  return `${a.coin} 别接：${long ? "碰到关键低点后还在创新低" : "碰到关键高点后还在创新高"}`;
}

/** Position per 1% of capital at risk, from the distance to the stop. */
export function sizeLine(entry: number, stop: number): string {
  const dist = Math.abs(entry - stop) / entry;
  if (!(dist > 0)) return "";
  const mult = 0.01 / dist;
  return `按止损算仓位：止损距离 ${(dist * 100).toFixed(2)}%，每承担本金 1% 的风险，仓位约为本金的 ${mult.toFixed(2)} 倍（本金 1 万 U，仓位约 ${fmtPrice(10000 * mult)} U；超过 1 倍就要用杠杆，注意强平价）。`;
}

function block(a: WatchAlert, siteUrl: string): string[] {
  const s = a.side, ev = s.event!;
  const long = s.dir > 0;
  const lines = [`【${alertTitle(a)}】${long ? "做多一侧" : "做空一侧"}`];
  if (s.level) lines.push(`关键位：${s.level.name} ${fmtPrice(s.level.price)}（${bj(ev.startT)} 碰到）`);
  lines.push(`最新${long ? "低点" : "高点"}：${fmtPrice(ev.extreme)}${ev.attempt > 1 ? `（第 ${ev.attempt} 次等待）` : ""}`);
  if (a.kind === "turned" && ev.turn) {
    lines.push(`入场参考：${fmtPrice(ev.turn.entry)}（15 分钟 ${bj(ev.turn.t + BAR)} 收盘价）`);
    lines.push(`止损：${fmtPrice(ev.turn.stop)}（最新${long ? "低点之下" : "高点之上"}，加扫损缓冲）`);
    const size = sizeLine(ev.turn.entry, ev.turn.stop);
    if (size) lines.push(size);
    if (againstBig(a.big, s.dir)) lines.push(`逆日线（日线${long ? "向下" : "向上"}）：按规则半仓，仓位按上面的一半。${BIG_TREND_FACTS.e37}`);
    lines.push(`之后如果又${long ? "跌破" : "涨破"} ${fmtPrice(ev.extreme)}，这次转${long ? "强" : "弱"}就作废，回到“别接”。`);
  } else {
    lines.push(`现在别接，等 15 分钟走出${long ? "更高的低点、再收盘站上最近的反弹高点" : "更低的高点、再收盘跌破最近的回落低点"}。转${long ? "强" : "弱"}时止损会放在约 ${fmtPrice(ev.stop)}。`);
  }
  if (a.big) lines.push(`大趋势（顺逆按日线算，周线只当背景）：${bigTrendRows(a.big).join("；")}`);
  if (siteUrl) lines.push(`页面：${siteUrl}/coin/${a.coin}?tab=watch`);
  return lines;
}

export function alertMailText(alerts: WatchAlert[], siteUrl = "", capNote = ""): { subject: string; text: string } {
  const subject = `盯盘提醒：${alerts.map(alertTitle).map((t) => t.split("：")[0]).join("、")}`;
  const research = alerts.find((a) => a.research)?.research;
  const lines = [
    ...alerts.flatMap((a) => [...block(a, siteUrl), ""]),
    research ?? "转强不预测方向，只是让你少接飞刀：等它出现再进，止损放在最新的低点（高点）之外。",
    "价格按 15 分钟已收盘的 K 线计算，从走出来到收到邮件最多约 15 分钟，再加上邮件投递的时间；下单前先打开页面看一眼现价。",
    ...(capNote ? ["", capNote] : []),
    "",
    "不想再收：后台“系统设置 → 盯盘邮件提醒”里关掉。",
  ];
  return { subject, text: lines.join("\n") };
}

// ---------------------------------------------------------------- running

const dayOf = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

function readSeen(): Record<string, number> | null {
  const raw = getState("watchAlert.seen");
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function watchedCoins(cfg: WatchAlertConfig): string[] {
  const shown = coinIds();
  return cfg.coins.length ? shown.filter((c) => cfg.coins.includes(c)) : shown;
}

/**
 * One round, for the 15-minute bar that closed at `closeSec`: each coin's live watch (waiting a
 * little for a bar that has not arrived yet), new alerts in one mail. Returns what was mailed.
 */
export async function runWatchAlerts(closeSec: number, opts: { retryMs?: number; tries?: number } = {}): Promise<WatchAlert[]> {
  const cfg = getWatchAlertConfig();
  const mail = alertMail(cfg);
  if (!cfg.enabled || !mailReady(mail)) return [];
  const views: WatchView[] = [];
  for (const coin of watchedCoins(cfg)) {
    for (let k = 0; k < (opts.tries ?? 3); k++) {
      try {
        const v = await getWatch(coin);
        if (v.end >= closeSec || k === (opts.tries ?? 3) - 1) {
          views.push(v);
          break;
        }
      } catch (e) {
        if (k === (opts.tries ?? 3) - 1) logger.warn("engine", `盯盘提醒：${coin} 计算失败`, { error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, opts.retryMs ?? 30_000));
    }
    await new Promise((r) => setImmediate(r));
  }

  const prev = readSeen();
  const seen = prev ?? {};
  const fresh = pickAlerts(views, cfg, seen, closeSec);
  for (const a of fresh) seen[a.key] = closeSec;
  for (const [k, t] of Object.entries(seen)) if (closeSec - t > SEEN_KEEP_SEC) delete seen[k];
  setState("watchAlert.seen", JSON.stringify(seen));
  // the first round only learns what is already going on
  if (prev == null || !fresh.length) return [];

  const today = dayOf(closeSec * 1000);
  const [d, n] = (getState("watchAlert.day") ?? "").split("|");
  const count = d === today ? Number(n) || 0 : 0;
  if (count >= cfg.dailyCap) {
    logger.info("system", "盯盘提醒已到今天的上限，没有发信", { alerts: fresh.map((a) => a.key), cap: cfg.dailyCap });
    return [];
  }
  setState("watchAlert.day", `${today}|${count + 1}`);
  const capNote = count + 1 >= cfg.dailyCap ? `今天的盯盘提醒已到上限 ${cfg.dailyCap} 封，北京时间明天 0 点前不再发。` : "";
  const { subject, text } = alertMailText(fresh, cfg.siteUrl, capNote);
  await sendMail(subject, text, mail).catch(() => {
    // already logged by sendMail
  });
  return fresh;
}

/** A sample mail with the coins' current watch, so the settings can be checked end to end. */
export async function sendTestAlert(input: WatchAlertInput): Promise<string[]> {
  const cfg = mergeWatchAlertConfig({ ...input, enabled: false });
  const mail = alertMail(cfg);
  if (!mailReady(mail)) throw new Error("邮件还没有配置完整：请先在上面的“邮件与告警”里填好并保存，再填收件邮箱");
  const lines: string[] = ["这是一封测试提醒。正式提醒只在出现“已转强 / 已转弱”" + (cfg.falling ? "或“别接”" : "") + "时发，内容和下面的格式一样。", "", "现在的盯盘状态："];
  for (const coin of watchedCoins(cfg)) {
    try {
      lines.push(`· ${(await getWatch(coin)).headline}`);
    } catch (e) {
      lines.push(`· ${coin}：计算失败（${(e as Error).message}）`);
    }
  }
  if (cfg.siteUrl) lines.push("", `页面：${cfg.siteUrl}/watch`);
  await sendMail("盯盘提醒（测试）", lines.join("\n"), mail);
  return mail.to;
}

const g = globalThis as unknown as { __slWatchAlert?: NodeJS.Timeout };

/** Run after every 15-minute close (20 seconds in, so the exchange has the bar). */
export function startWatchAlerts() {
  if (g.__slWatchAlert) return;
  const schedule = () => {
    const now = Date.now();
    const close = (Math.floor(now / 1000 / BAR) + 1) * BAR;
    g.__slWatchAlert = setTimeout(async () => {
      try {
        await runWatchAlerts(close);
      } catch (e) {
        logger.error("system", "盯盘提醒执行失败", { error: e });
      }
      schedule();
    }, close * 1000 + 20_000 - now);
    g.__slWatchAlert.unref?.();
  };
  schedule();
}
