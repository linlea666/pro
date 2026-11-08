"use client";

import type { Account, Holding, HoldingView } from "@/lib/rollbook";
import { BIG_TREND_FACTS } from "@/lib/ta/bigtrend";
import { addTiers, hedgePlan, losingMatrix, mustExit, RESEARCH, winningMatrix, type DecisionRow, type Verdict } from "@/lib/ta/decide";
import { nextAddLevel, trimQty } from "@/lib/ta/roll";
import { fmtPrice } from "../coin/format";
import { money, toneColor } from "./ui";

const VERDICT: Record<Verdict, string> = { 建议: "text-up", 可以: "text-ink-2", 不建议: "text-down", 临时: "text-warn" };

/**
 * The decision at the next key level, both sides, in USDT and against the research: what each choice makes if
 * the market goes your way and if it turns, and what the past says about it. Winners also get the three add tiers.
 */
export function DecisionPanel({ h, v, acc }: { h: Holding; v: HoldingView; acc: Account }) {
  const { pos, price, stop } = v;
  if (!(pos.qty > 0) || price == null) return null;
  const losing = h.dir * (price - pos.avg) <= 0;
  const budget = acc.budget === "even" ? 0 : (acc.total * acc.riskPct) / 100;
  if (losing) {
    const m = losingMatrix({ dir: h.dir, pos, price, stop, anchor: v.st?.anchor ?? null, fee: acc.fee, budget, posMode: acc.snap?.posMode ?? null });
    return (
      <div className="space-y-2">
        <h3 className="text-[15px] font-semibold">亏损时的选择</h3>
        <p className="text-sm text-ink-2">{m.zone}</p>
        <Matrix rows={m.rows} good="回到均价" bad={stop != null ? `打到止损 ${fmtPrice(stop)}` : "打到止损"} />
        <p className="text-[11px] leading-relaxed text-ink-3">研究 E47（10 个币 4 小时，2,039 笔，入场和止损同计划页）：{RESEARCH.e47.scaleIn}{RESEARCH.e47.average}所以这里不推荐补仓位置；想看具体数字，到“加减仓试算”里算。</p>
      </div>
    );
  }
  const level = v.addLevel ?? nextAddLevel(h.dir, price, v.levels);
  if (level == null || stop == null) return null;
  const after = v.levels.filter((x) => h.dir * (x - level) > 0).sort((a, b) => h.dir * (a - b))[0] ?? level + h.dir * (v.atr ?? price * 0.01);
  const tiers = addTiers({ pos, at: level, stop, budget, mode: h.mode, leverage: h.leverage, account: acc.total, atr: v.atr, fee: acc.fee, available: v.available, liqOf: v.liqOf });
  const rows = winningMatrix({ dir: h.dir, pos, level, beyond: after, stop, fee: acc.fee, addQty: tiers[1].qty, aggressiveQty: tiers[2].qty });
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <h3 className="text-[15px] font-semibold">到前方关键位 {fmtPrice(level)} 时的选择</h3>
        <Matrix rows={rows} good={`冲到 ${fmtPrice(after)}`} bad={`反转打到止损 ${fmtPrice(stop)}`} />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-[15px] font-semibold">收盘{h.dir > 0 ? "站上" : "跌破"} {fmtPrice(level)} 后，三档加仓</h3>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="num w-full min-w-[640px] text-sm">
            <thead className="bg-panel-2 text-left text-xs text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">档位</th>
                <th className="px-3 py-2 text-right font-medium">最多加 · 保证金</th>
                <th className="px-3 py-2 text-right font-medium">加完均价</th>
                <th className="px-3 py-2 text-right font-medium">新强平</th>
                <th className="px-3 py-2 text-right font-medium">打到止损</th>
                <th className="px-3 py-2 text-right font-medium">回吐到这里减 1/3</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.name} className="border-t border-line">
                  <td className="px-3 py-2">{t.name}{t.binding === "house" && <span className="block text-xs text-ink-3">受浮盈限制：只用已有浮盈加</span>}</td>
                  <td className="px-3 py-2 text-right">{t.qty > 0 ? `${trimQty(t.qty)} · ${t.margin.toFixed(0)}` : "不能加"}</td>
                  <td className="px-3 py-2 text-right">{t.qty > 0 ? fmtPrice(t.avg) : "—"}</td>
                  <td className="px-3 py-2 text-right">{t.qty > 0 ? fmtPrice(t.liq) : "—"}</td>
                  <td className={`px-3 py-2 text-right ${toneColor(t.atStop)}`}>{t.qty > 0 ? money(t.atStop) : "—"}</td>
                  <td className="px-3 py-2 text-right">{t.qty > 0 ? fmtPrice(t.giveback) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] leading-relaxed text-ink-3">
          保守 = 加完打到止损也不亏、每次最多和上一笔一样多；标准 = 加完打到止损最多亏每笔风险、每次不超过上一笔一半、最多 3 次；激进 = 同样的风险预算、每次可以和上一笔一样多、最多 5 次{h.mode === "isolated" ? "，逐仓时每次加仓的保证金不超过当时的浮盈（只用赚来的钱滚，本金风险不变）" : ""}。所有档位都要求强平在止损外至少 1 倍 ATR、可用保证金够。“回吐到这里减 1/3”是加完后浮盈吐回一半的价格。回测（E31 / E47b）：稳健 +{RESEARCH.e31.steady}R、激进 +{RESEARCH.e31.aggressive}R 对不滚 +{RESEARCH.e31.none}R / 笔，都不达标；激进最大回撤 {RESEARCH.e31.ddAggressive}R（不滚 {RESEARCH.e31.ddNone}R）。激进只是在大行情里拿得更重，不提高每笔的期望。
        </p>
      </div>
    </div>
  );
}

function Matrix({ rows, good, bad }: { rows: DecisionRow[]; good: string; bad: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-panel-2 text-left text-xs text-ink-3">
          <tr>
            <th className="px-3 py-2 font-medium">做法</th>
            <th className="px-3 py-2 text-right font-medium">{good}</th>
            <th className="px-3 py-2 text-right font-medium">{bad}</th>
            <th className="px-3 py-2 font-medium">历史上</th>
            <th className="px-3 py-2 font-medium">结论</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.action} className="border-t border-line align-top">
              <td className="px-3 py-2">{r.action}</td>
              <td className={`num px-3 py-2 text-right ${toneColor(r.good ?? 0)}`}>{r.good != null ? money(r.good) : "—"}</td>
              <td className={`num px-3 py-2 text-right ${toneColor(r.bad ?? 0)}`}>{r.bad != null ? money(r.bad) : "—"}</td>
              <td className="px-3 py-2 text-xs leading-relaxed text-ink-2">{r.hist}</td>
              <td className={`whitespace-nowrap px-3 py-2 font-semibold ${VERDICT[r.verdict]}`}>{r.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** P4: the daily trend against the position — the stop that has to hold, the bounce exit, and the lock calculator. */
export function TrendExit({ h, v, acc }: { h: Holding; v: HoldingView; acc: Account }) {
  const { pos, price } = v;
  if (!(pos.qty > 0) || price == null || !v.big) return null;
  const x = mustExit({ dir: h.dir, price, avg: pos.avg, stop: v.stop, structureStop: v.st?.stop ?? null, levels: v.levels, big: v.big, liq: v.liq });
  if (!x) return null;
  const hp = hedgePlan({ dir: h.dir, qty: pos.qty, avg: pos.avg, price, leverage: h.leverage, fee: acc.fee, funding: v.funding, posMode: acc.snap?.posMode ?? null, flip: x.flip });
  return (
    <div className="space-y-2 rounded-lg border border-down/40 bg-down-soft p-3 text-sm">
      <p className="font-semibold">⚠ {x.trend}，和你的{h.dir > 0 ? "多单" : "空单"}方向相反</p>
      <ul className="space-y-1 text-ink-2">
        <li>
          必须守住的止损：<b className="num">{fmtPrice(x.stop)}</b>（交易所止损单和 4 小时结构认错位里更近的那个）
          {x.stopBeforeLiq === false && <b className="text-down">；它在强平价 {fmtPrice(v.liq)} 后面，等于没有止损，先减仓或挪止损</b>}
          {h.ex && h.ex.sl == null && <b className="text-down">；交易所还没有止损单，先挂上</b>}。
        </li>
        <li>{x.exit != null ? <>反弹到 <b className="num">{fmtPrice(x.exit)}</b> 一带，4 小时收盘{h.dir > 0 ? "站不上" : "跌不破"}就离场，不必等到止损。</> : "均价和现价之间没有关键位：按止损走。"}</li>
        {x.flip != null && <li>日线收盘{h.dir > 0 ? "站回" : "跌回"} <b className="num">{fmtPrice(x.flip)}</b> 才算日线方向转回你这边；在那之前不加仓。</li>}
      </ul>
      <p className="text-[11px] text-ink-3">{BIG_TREND_FACTS.e37}</p>
      <details>
        <summary className="cursor-pointer text-ink-2">锁仓计算（不建议，只在暂时无法盯盘时临时用）</summary>
        <div className="mt-2 space-y-2">
          {!hp.possible && <p className="text-warn">{acc.snap ? "这个账户是单向持仓：开反向单只会减仓，不能锁仓。要锁仓需要在交易所切换到双向持仓。" : "手动账户不知道持仓模式：交易所是单向持仓时，开反向单只会减仓。"}</p>}
          <table className="num w-full text-sm">
            <thead className="text-xs text-ink-3">
              <tr>
                <th className="py-1 text-left font-normal">做法</th>
                <th className="py-1 text-right font-normal">反向单数量</th>
                <th className="py-1 text-right font-normal">定住的浮动盈亏</th>
                <th className="py-1 text-right font-normal">多付手续费</th>
                <th className="py-1 text-right font-normal">多占保证金</th>
                <th className="py-1 text-right font-normal">之后每天资金费</th>
              </tr>
            </thead>
            <tbody>
              {hp.rows.map((r) => (
                <tr key={r.name} className="border-t border-line">
                  <td className="py-1">{r.name}</td>
                  <td className="py-1 text-right">{trimQty(r.qty)}</td>
                  <td className={`py-1 text-right ${toneColor(r.frozen)}`}>{money(r.frozen)}</td>
                  <td className="py-1 text-right">{r.fees.toFixed(1)}</td>
                  <td className="py-1 text-right">{r.margin.toFixed(0)}</td>
                  <td className="py-1 text-right">{r.fundingDay ? `${r.fundingDay > 0 ? "付" : "收"} ${Math.abs(r.fundingDay).toFixed(1)}` : "相抵"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-ink-2">{hp.unlock}</p>
          <p className="text-[11px] leading-relaxed text-ink-3">锁仓把浮亏定在现在、推迟认错：手续费付两次，占两份保证金，解锁时要再判断一次方向，实盘里常见解锁后再亏一次。能减仓或止损时，优先减仓或止损。</p>
        </div>
      </details>
    </div>
  );
}
