import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-wa-"));
process.env.LOG_LEVEL = "error";
process.env.MASTER_KEY = "ab".repeat(32);
const { alertMailText, mergeWatchAlertConfig, pickAlerts, sizeLine, DEFAULT_WATCH_ALERT } = await import("../src/lib/server/watchalert.ts");
type View = Parameters<typeof pickAlerts>[0][number];

const close = 1_760_000_400; // a 15-minute close
const side = (dir: 1 | -1, state: string, attempt = 1, turnT: number | null = close - 900) => ({
  dir,
  t: close - 900,
  state,
  level: { price: 82500, kind: "prevWeek", name: "上周低点" },
  distAtr: -0.2,
  atr1h: 400,
  event: {
    startT: close - 40 * 900,
    bars: 40,
    extreme: 82150,
    extremeT: close - 10 * 900,
    bounce: 83000,
    attempt,
    newExtremes: [],
    reclaimed: true,
    turn: state === "turned" && turnT != null ? { t: turnT, entry: 83100, stop: 81812, extreme: 82150 } : null,
    hourTurned: false,
    stop: 81812,
  },
});
const view = (coin: string, long: unknown, short: unknown = { dir: -1, state: "far", event: null }) => ({ coin, long, short, research: null }) as unknown as View;

test("watch alerts: a fresh turn is news once; a turn undone and made again is a new one", () => {
  const cfg = { turned: true, falling: false };
  const a = pickAlerts([view("BTC", side(1, "turned"))], cfg, {}, close);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "turned");
  const seen = { [a[0].key]: close };
  assert.equal(pickAlerts([view("BTC", side(1, "turned"))], cfg, seen, close + 900).length, 0);
  // new low after the turn, then turned again: attempt 2
  assert.equal(pickAlerts([view("BTC", side(1, "turned", 2))], cfg, seen, close + 1800).length, 1);
  // "别接" only when switched on
  assert.equal(pickAlerts([view("BTC", side(1, "falling"))], cfg, {}, close).length, 0);
  assert.equal(pickAlerts([view("BTC", side(1, "falling"))], { turned: true, falling: true }, {}, close).length, 1);
  // a turn from hours ago (the server was down) is not mailed
  assert.equal(pickAlerts([view("BTC", side(1, "turned", 1, close - 6 * 3600))], cfg, {}, close).length, 0);
});

test("watch alerts: one mail for every coin of the close, with entry, stop and size", () => {
  const alerts = pickAlerts([view("BTC", side(1, "turned")), view("ETH", { dir: 1, state: "far", event: null }, { ...side(-1, "turned"), level: { price: 4000, kind: "prevDay", name: "前一日高点" } })], { turned: true, falling: false }, {}, close);
  assert.equal(alerts.length, 2);
  const m = alertMailText(alerts, "http://1.2.3.4:3000");
  assert.equal(m.subject, "盯盘提醒：BTC 已转强、ETH 已转弱");
  assert.match(m.text, /入场参考：83,100/);
  assert.match(m.text, /止损：81,812/);
  assert.match(m.text, /http:\/\/1\.2\.3\.4:3000\/coin\/BTC\?tab=watch/);
  assert.match(m.text, /转强不预测方向/);
  assert.match(sizeLine(100, 98), /止损距离 2\.00%.*0\.50 倍/);
});

test("watch alerts: settings are checked before saving", () => {
  const mail = { host: "smtp.qq.com", port: 465, security: "ssl" as const, user: "a@qq.com", passEnc: "x", to: ["a@qq.com"], alertsEnabled: false };
  const c = mergeWatchAlertConfig({ enabled: true, coins: "btc, eth", to: "" }, DEFAULT_WATCH_ALERT, mail);
  assert.deepEqual(c.coins, ["BTC", "ETH"]);
  assert.throws(() => mergeWatchAlertConfig({ enabled: true }, DEFAULT_WATCH_ALERT, { ...mail, passEnc: null }), /SMTP/);
  assert.throws(() => mergeWatchAlertConfig({ to: "bad" }, DEFAULT_WATCH_ALERT, mail), /收件邮箱/);
  assert.throws(() => mergeWatchAlertConfig({ enabled: true, turned: false, falling: false }, DEFAULT_WATCH_ALERT, mail), /至少/);
  assert.throws(() => mergeWatchAlertConfig({ siteUrl: "1.2.3.4" }, DEFAULT_WATCH_ALERT, mail), /网站地址/);
});
