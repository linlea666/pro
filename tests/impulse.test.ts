import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candle } from "../src/lib/types.ts";
import { atrSeries } from "../src/lib/ta/risk.ts";
import { IMPULSE_FACTS, IMPULSE_RULES, impulseHeadline, impulseLines, impulseTrigger, latestImpulse, quietLabelOf, quietRanks, quietText, trailText } from "../src/lib/ta/impulse.ts";
import { impulseBrief } from "../src/lib/ta/brief.ts";
import { forbiddenPhrase } from "../src/lib/tdbrief.ts";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-imp-"));
process.env.LOG_LEVEL = "error";
process.env.MASTER_KEY = "ab".repeat(32);
const { alertMailText, alertTitle, mergeWatchAlertConfig, pickAlerts, DEFAULT_WATCH_ALERT } = await import("../src/lib/server/watchalert.ts");
type View = Parameters<typeof pickAlerts>[0][number];

const T0 = 1_760_000_400 - (1_760_000_400 % 3600);

/** `flat` quiet hours (±0.2% zig-zag, volume 100), then `run` hours of +1% each (volume 300), then `after` given closes */
function series(flat = 200, run = 12, after: number[] = []): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  const push = (c: number, v: number) => {
    const o = p;
    out.push({ t: T0 + out.length * 3600, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v });
    p = c;
  };
  for (let i = 0; i < flat; i++) push(100 * (i % 2 ? 1.002 : 0.998), 100);
  for (let i = 0; i < run; i++) push(p * 1.01, 300);
  for (const c of after) push(c, 120);
  return out;
}

test("impulse: counted once, on the first close where speed, clean path and volume all hold", () => {
  const c = series(200, 12);
  const atr = atrSeries(c);
  const k = c.findIndex((_, i) => impulseTrigger(c, atr, i) !== 0);
  assert.ok(k > 200, `the trigger is inside the run (k=${k})`);
  assert.equal(impulseTrigger(c, atr, k), 1);
  // the next bar of the same run is not a new trigger
  for (let i = k + 1; i < c.length; i++) assert.equal(impulseTrigger(c, atr, i), 0);
  // without the volume it is not an impulse
  const quietVol = c.map((x) => ({ ...x, v: 100 }));
  assert.equal(quietVol.findIndex((_, i) => impulseTrigger(quietVol, atr, i) !== 0), -1);
});

test("impulse: the 3-ATR chandelier follows the high and ends when a wick touches it", () => {
  const base = series(200, 12);
  const top = base[base.length - 1].c;
  const live = latestImpulse(base, atrSeries(base));
  assert.ok(live && live.active && live.dir === 1);
  assert.ok(live.trail < live.extreme && live.extreme >= live.entry, "the stop is under the high since the entry");
  // a few more hours drifting up: still on, stop only moves up
  const up = series(200, 12, [top * 1.003, top * 1.006, top * 1.009]);
  const a = latestImpulse(up, atrSeries(up))!;
  assert.ok(a.active && a.trail >= live.trail);
  // a 6% drop goes through the stop: over
  const down = series(200, 12, [top * 1.003, top * 0.94]);
  const b = latestImpulse(down, atrSeries(down))!;
  assert.equal(b.active, false);
  assert.equal(b.endedT, down[down.length - 1].t);
  // more than `maxBars` later: not shown any more
  const late = series(200, 12, Array.from({ length: IMPULSE_RULES.maxBars + 2 }, (_, i) => top * (1 + 0.002 * i)));
  assert.equal(latestImpulse(late, atrSeries(late)), null);
});

test("impulse: quiet ranks and labels", () => {
  assert.equal(quietLabelOf(null), null);
  assert.equal(quietLabelOf(0.1), "安静");
  assert.equal(quietLabelOf(0.5), "正常");
  assert.equal(quietLabelOf(0.9), "动荡");
  // a year of calm hours, then a wild week: the day after the wild week ranks at the top
  const h: Candle[] = [];
  const days = IMPULSE_RULES.quietDays + 20;
  let p = 100;
  for (let i = 0; i < days * 24; i++) {
    const wild = i >= (days - 9) * 24 && i < (days - 2) * 24;
    const c = p * (i % 2 ? 1 + (wild ? 0.02 : 0.002) : 1 - (wild ? 0.02 : 0.002));
    h.push({ t: T0 + i * 3600, o: p, h: Math.max(p, c), l: Math.min(p, c), c, v: 1 });
    p = c;
  }
  const r = quietRanks(h);
  const lastDay = Math.floor(h[h.length - 1].t / 86400) * 86400;
  assert.ok((r.get(lastDay) ?? 0) > 0.9, `wild week ranks high (${r.get(lastDay)})`);
});

test("impulse: every sentence stays descriptive", () => {
  const c = series(200, 12);
  const x = { ...latestImpulse(c, atrSeries(c))!, quiet: 0.8, quietLabel: "动荡" as const };
  const down = { ...x, dir: -1 as const, movePct: -4.2, moveAtr: -6.1 };
  const at = (s: number) => new Date(s * 1000).toISOString();
  const texts = [...Object.values(IMPULSE_FACTS), impulseHeadline(x), impulseHeadline(down), quietText(x)!, trailText(x), trailText(down), impulseBrief(x), impulseBrief(down), ...impulseLines(x, at), ...impulseLines(down, at)];
  for (const t of texts) assert.equal(forbiddenPhrase(t), null, t);
  assert.match(impulseHeadline(down), /12 小时 −4\.2%/);
  assert.match(impulseBrief(down), /别接飞刀做多/);
  assert.match(impulseBrief(x), /别摸顶做空/);
});

test("impulse mail: off by default, fresh triggers only, once per impulse", () => {
  assert.equal(DEFAULT_WATCH_ALERT.impulse, false);
  const c = series(200, 12);
  const x = latestImpulse(c, atrSeries(c))!;
  const close = x.t + 3600; // the hour the impulse closed
  const far = { dir: 1, state: "far", event: null };
  const v = { coin: "BTC", long: far, short: { ...far, dir: -1 }, research: null, impulse: x, big: null } as unknown as View;
  assert.equal(pickAlerts([v], { turned: true, falling: false }, {}, close).length, 0, "switch off: no mail");
  const cfg = { turned: true, falling: false, impulse: true };
  const a = pickAlerts([v], cfg, {}, close + 900);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "impulse");
  assert.equal(alertTitle(a[0]), "BTC 放量冲击向上：别逆着做");
  assert.equal(pickAlerts([v], cfg, { [a[0].key]: close }, close + 1800).length, 0, "already mailed");
  assert.equal(pickAlerts([v], cfg, {}, close + 3 * 3600).length, 0, "hours later (server was down): not news");
  assert.equal(pickAlerts([{ ...v, impulse: { ...x, active: false } } as View], cfg, {}, close).length, 0, "already over");
  const m = alertMailText(a, "http://1.2.3.4:3000");
  assert.equal(m.subject, "盯盘提醒：BTC 放量冲击向上");
  assert.match(m.text, /别逆着做/);
  assert.match(m.text, /不是入场信号/);
  assert.doesNotMatch(m.text, /转强不预测方向/);
  assert.equal(forbiddenPhrase(m.text), null);
  // it counts as something to be reminded of
  const mail = { host: "smtp.qq.com", port: 465, security: "ssl" as const, user: "a@qq.com", passEnc: "x", to: ["a@qq.com"], alertsEnabled: false };
  assert.equal(mergeWatchAlertConfig({ enabled: true, turned: false, falling: false, impulse: true }, DEFAULT_WATCH_ALERT, mail).impulse, true);
});
