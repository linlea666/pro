"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { SpotPage } from "@/lib/spot/page";
import { buildLadder, expandHistory, levelPrices, replay, scenarios, snapLevels, validateStack, type ScenarioResult, type StackInput } from "@/lib/spot/stack";
import type { PriceRef } from "@/lib/spot/valuation";
import { track } from "../track";
import { Card, fmtBtc, fmtShare, fmtSigned, fmtUsd, Fold, type Mode } from "./spot-ui";
import { loadStack, StackLog, type StackForm } from "./StackLog";

/** ⑧ The accumulation planner: inputs → ladder → buckets → three paths → history replay → the visitor's own log. */
export function StackPlanner({ d, mode }: { d: SpotPage; mode: Mode }) {
  const live = d.live.price;
  const def = d.stackDefaults;
  const [f, setF] = useState<StackForm>(() => {
    const head = Math.max(1000, Math.round(live / 1000) * 1000);
    return {
      budget: 10_000,
      head,
      floor: Math.round((head * 0.6) / 1000) * 1000,
      levels: def.levels,
      shape: def.shape === "equal" ? "equal" : "pyramid",
      dcaPct: Math.round(def.dcaShare * 100),
      reservePct: Math.round(def.reserveShare * 100),
      horizon: def.horizonDays,
      fomo: true,
      snap: false,
    };
  });
  // a saved plan comes back as the starting point
  useEffect(() => {
    const s = loadStack();
    if (s?.plan) setF(s.plan.form);
  }, []);
  const set = <K extends keyof StackForm>(k: K, v: StackForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    track("use_stack", "stack");
  };

  const plan = useMemo(() => buildInput(f, def, d.refs), [f, def, d.refs]);
  const x = plan.errors.length ? null : plan.x;
  const ladder = useMemo(() => (x ? buildLadder(x, d.refs) : null), [x, d.refs]);
  const paths = useMemo(() => (x ? scenarios(x, { currentPrice: live, reservePrice: d.reservePrice }) : null), [x, live, d.reservePrice]);
  const hist = useMemo(() => expandHistory(d.history), [d.history]);
  const xr = useDeferredValue(x);
  const rep = useMemo(() => (xr ? replay(xr, hist, { currentPrice: live }) : null), [xr, hist, live]);

  return (
    <Card title="攒币计划：手上有多少钱、在哪些价格各买多少" id="stack">
      <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
        把一笔钱分成三份：<b className="text-ink">定投</b>每周买一次，保证一定买进去；<b className="text-ink">限价梯</b>在几个更低的价格挂单，跌下来才买；<b className="text-ink">预备金</b>留给跌破 200 周均线或 MVRV &lt; 1 这种少见的时候。期限到了，没成交的钱照样买进去，不在场外一直等。
      </p>

      <Inputs f={f} set={set} reservePrice={d.reservePrice} />
      {plan.errors.length > 0 && (
        <ul className="mt-2 space-y-0.5 rounded-lg bg-down-soft px-3 py-2 text-[12px] text-down">
          {plan.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {x && ladder && (
        <div className="mt-4 space-y-5">
          <LadderTable ladder={ladder} snapped={plan.snapped} snap={f.snap} onSnap={(v) => set("snap", v)} />
          <Buckets x={x} ladder={ladder} reservePrice={d.reservePrice} reserveNow={d.now.reserve} fomo={f.fomo} fomoPct={def.fomoPct} fomoWeeks={def.fomoWeeks} />
          {paths && <Paths paths={paths} budget={x.budget} weeks={ladder.dcaWeeks} />}
          <Replay rep={rep} pending={xr !== x} />
        </div>
      )}

      <div className="mt-5 border-t border-line pt-4">
        <StackLog form={f} x={x} ladder={ladder} live={live} reservePrice={d.reservePrice} />
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <h3 className="text-[14px] font-semibold">你可能还没想到的</h3>
        <Fold key={mode} defaultOpen={mode === "pro"} label={["展开", "收起"]}>
          <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-ink-2">
            <li>只用现货，不加杠杆；这笔钱最好 4 年内用不到，另留生活备用金，不然跌到最深那档时可能被迫卖出。</li>
            <li>不要每跌一段就重排档位：那样往往一分没买。只在期限到、跌破最后一档、涨过头仓价这些规则触发时重排，并记下来。</li>
            <li>大额现货攒完后，建议提到自己的钱包，不长期放在交易所。</li>
            <li>第一版只算 BTC：这笔计划就是单一资产的全部仓位，不是分散投资。</li>
          </ul>
        </Fold>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- input → StackInput

function buildInput(f: StackForm, def: SpotPage["stackDefaults"], refs: PriceRef[]) {
  const x: StackInput = {
    budget: f.budget,
    headPrice: f.head,
    floorPrice: f.floor,
    levels: f.levels,
    shape: f.shape,
    spacing: def.spacing,
    dcaShare: f.dcaPct / 100,
    reserveShare: f.reservePct / 100,
    horizonDays: f.horizon,
    // off: a line nothing reaches (validated with the default, which the rule checks only for range)
    fomoPct: f.fomo ? def.fomoPct : Infinity,
    fomoWeeks: def.fomoWeeks,
  };
  const errors = validateStack({ ...x, fomoPct: def.fomoPct });
  let snapped: (PriceRef | null)[] = [];
  if (!errors.length && f.snap) {
    const s = snapLevels(levelPrices(x), refs);
    // keep the order strictly falling: a level that would land on or above the one before stays put
    const raw = levelPrices(x);
    const prices: number[] = [];
    snapped = s.map((v, k) => {
      const ok = k === 0 || v.price < prices[k - 1];
      prices.push(ok ? v.price : raw[k]);
      return ok ? v.snapped : null;
    });
    x.prices = prices;
    errors.push(...validateStack({ ...x, fomoPct: def.fomoPct }));
  }
  return { x, errors, snapped };
}

// ---------------------------------------------------------------- inputs

const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent";

function Num({ id, label, value, onChange, suffix, step = 1 }: { id: string; label: string; value: number; onChange: (v: number) => void; suffix?: string; step?: number }) {
  return (
    <label className="block min-w-0 space-y-1" htmlFor={id}>
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className="flex items-center gap-1.5">
        <input id={id} type="number" inputMode="decimal" step={step} className={field} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.value === "" ? NaN : +e.target.value)} />
        {suffix && <span className="shrink-0 text-[12px] text-ink-3">{suffix}</span>}
      </span>
    </label>
  );
}

function Inputs({ f, set, reservePrice }: { f: StackForm; set: <K extends keyof StackForm>(k: K, v: StackForm[K]) => void; reservePrice: number | null }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Num id="stack-budget" label="资金（USDT）" value={f.budget} onChange={(v) => set("budget", v)} step={1000} />
        <Num id="stack-head" label="头仓价（第一档）" value={f.head} onChange={(v) => set("head", v)} step={1000} />
        <Num id="stack-floor" label="最低预期价（最后一档）" value={f.floor} onChange={(v) => set("floor", v)} step={1000} />
        <label className="block min-w-0 space-y-1" htmlFor="stack-levels">
          <span className="text-[12px] text-ink-3">档数</span>
          <select id="stack-levels" className={field} value={f.levels} onChange={(e) => set("levels", +e.target.value)}>
            {[3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n} 档
              </option>
            ))}
          </select>
        </label>
        <Num id="stack-dca" label="定投比例" value={f.dcaPct} onChange={(v) => set("dcaPct", v)} suffix="%" step={5} />
        <Num id="stack-reserve" label="预备金比例（0–50%）" value={f.reservePct} onChange={(v) => set("reservePct", v)} suffix="%" step={5} />
        <Num id="stack-horizon" label="期限" value={f.horizon} onChange={(v) => set("horizon", Math.round(v))} suffix="天" step={30} />
        <div className="min-w-0 space-y-1">
          <span className="text-[12px] text-ink-3">限价梯的分配</span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="限价梯的分配">
            {(
              [
                ["pyramid", "金字塔"],
                ["equal", "等额"],
              ] as const
            ).map(([k, t]) => (
              <button key={k} id={`stack-shape-${k}`} role="radio" aria-checked={f.shape === k} className="chip flex-1 !px-2" data-active={f.shape === k} onClick={() => set("shape", k)}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 text-[12px] leading-relaxed text-ink-3">
        <span>
          限价梯 = 100% − 定投 − 预备金 = <b className="num text-ink-2">{Number.isFinite(f.dcaPct + f.reservePct) ? `${100 - f.dcaPct - f.reservePct}%` : "—"}</b>。金字塔越往下钱越多；等额每档一样。
        </span>
        <span>
          预备金在跌破 200 周均线或 MVRV &lt; 1 时买（现在约 <b className="num text-ink-2">{fmtUsd(reservePrice)}</b> 以下），期限到了还没触发就按当时价格买入。
        </span>
        <label className="flex cursor-pointer items-start gap-2 text-ink-2">
          <input id="stack-fomo" type="checkbox" className="mt-0.5" checked={f.fomo} onChange={(e) => set("fomo", e.target.checked)} />
          <span>
            防踏空：价格涨过头仓价 15% 时，限价梯没用完的钱改成之后 8 周每周买一份。
            <span className="block text-ink-3">E23 回放里去掉这一条，最差 10% 的起点攒到的币明显更少。</span>
          </span>
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ladder

function RefChip({ r }: { r: PriceRef & { distPct?: number } }) {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[11px]"
      style={r.kind === "opinion" ? { color: "var(--accent)", borderColor: "var(--accent)" } : { color: "var(--text-2)", borderColor: "var(--border)" }}
    >
      {r.kind === "opinion" && <span className="text-[10px] font-medium">观点</span>}
      {r.label} {fmtUsd(r.price)}
      {r.distPct != null && <span className="text-ink-3">{fmtSigned(r.distPct)}</span>}
    </span>
  );
}

function LadderTable({ ladder, snapped, snap, onSnap }: { ladder: NonNullable<ReturnType<typeof buildLadder>>; snapped: (PriceRef | null)[]; snap: boolean; onSnap: (v: boolean) => void }) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-semibold">限价梯 · {fmtUsd(ladder.ladderUsd)} USDT</h3>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-2">
          <input id="stack-snap" type="checkbox" checked={snap} onChange={(e) => onSnap(e.target.checked)} />
          对齐到附近 ±3% 的参考价
        </label>
      </div>
      {/* phones: one card per level */}
      <ul className="num space-y-1.5 sm:hidden">
        {ladder.rows.map((r, k) => (
          <li key={k} className="rounded-lg border border-line px-3 py-2 text-[12px] leading-relaxed">
            <div className="flex items-baseline gap-2">
              <span className="text-ink-3">第 {k + 1} 档</span>
              <b className="text-[14px] text-ink">{fmtUsd(r.price)}</b>
              {snap && snapped[k] && <span className="text-[10px] text-accent">已对齐</span>}
              <span className="ml-auto text-ink-2">
                {fmtUsd(r.usd)} U <span className="text-ink-3">（{fmtShare(r.weight)}）</span>
              </span>
            </div>
            <div className="text-ink-2">
              买 {fmtBtc(r.btc)} BTC · 累计 {fmtBtc(r.cumBtc)} BTC，均价 {fmtUsd(r.cumAvgCost)}
            </div>
            {r.nearbyRefs.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {r.nearbyRefs.map((n) => (
                  <RefChip key={n.label} r={n} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="-mx-1 hidden overflow-x-auto px-1 sm:block">
        <table className="num w-full min-w-[600px] text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-ink-3">
              <th className="py-1.5 pr-2 font-normal">档</th>
              <th className="py-1.5 pr-2 text-right font-normal">价格</th>
              <th className="py-1.5 pr-2 text-right font-normal">金额</th>
              <th className="py-1.5 pr-2 text-right font-normal">能买多少币</th>
              <th className="py-1.5 pr-2 text-right font-normal">累计币数</th>
              <th className="py-1.5 pr-2 text-right font-normal">累计均价</th>
              <th className="py-1.5 pl-2 font-normal">附近参考价</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ladder.rows.map((r, k) => (
              <tr key={k}>
                <td className="py-1.5 pr-2 text-ink-3">{k + 1}</td>
                <td className="py-1.5 pr-2 text-right font-medium text-ink">
                  {fmtUsd(r.price)}
                  {snap && snapped[k] && <span className="block text-[10px] font-normal text-accent">已对齐</span>}
                </td>
                <td className="py-1.5 pr-2 text-right">
                  {fmtUsd(r.usd)} <span className="text-ink-3">（{fmtShare(r.weight)}）</span>
                </td>
                <td className="py-1.5 pr-2 text-right">{fmtBtc(r.btc)}</td>
                <td className="py-1.5 pr-2 text-right">{fmtBtc(r.cumBtc)}</td>
                <td className="py-1.5 pr-2 text-right">{fmtUsd(r.cumAvgCost)}</td>
                <td className="py-1.5 pl-2">
                  <div className="flex flex-wrap gap-1">
                    {r.nearbyRefs.length ? r.nearbyRefs.map((n) => <RefChip key={n.label} r={n} />) : <span className="text-ink-3">—</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
        币数已扣 0.1% 手续费。参考价只是让档位落在有意义的价格上，不代表那里会是底：关键位研究（E6、E16）没有证明它们比随便画的线更能止跌。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- buckets

function Buckets({ x, ladder, reservePrice, reserveNow, fomo, fomoPct, fomoWeeks }: { x: StackInput; ladder: NonNullable<ReturnType<typeof buildLadder>>; reservePrice: number | null; reserveNow: boolean; fomo: boolean; fomoPct: number; fomoWeeks: number }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[14px] font-semibold">计划一览</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-panel-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
          <div className="text-ink-3">定投桶 · {fmtShare(x.dcaShare)}</div>
          <div className="num text-[15px] font-semibold text-ink">每周 {fmtUsd(ladder.dcaPerWeek)} U</div>
          <div>
            买 {ladder.dcaWeeks} 周，共 {fmtUsd(ladder.dcaUsd)} U，今天买第一笔。
          </div>
        </div>
        <div className="rounded-lg bg-panel-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
          <div className="text-ink-3">限价梯 · {fmtShare(ladder.ladderUsd / x.budget)}</div>
          <div className="num text-[15px] font-semibold text-ink">
            {ladder.rows.length} 档 {fmtUsd(ladder.rows[0].price)} → {fmtUsd(ladder.rows[ladder.rows.length - 1].price)}
          </div>
          <div>
            全部成交约 {fmtBtc(ladder.totalBtc)} BTC，均价 {fmtUsd(ladder.avgCost)}。{x.horizonDays} 天到期没成交的按当时价格买入
            {fomo ? `；涨过头仓价 ${Math.round(fomoPct * 100)}% 时，剩下的钱分 ${fomoWeeks} 周买完` : "（防踏空已关闭）"}。
          </div>
        </div>
        <div className="rounded-lg bg-panel-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
          <div className="text-ink-3">预备金 · {fmtShare(x.reserveShare)}</div>
          <div className="num text-[15px] font-semibold text-ink">{fmtUsd(ladder.reserveUsd)} U</div>
          <div>
            {reserveNow ? "现在已经触发（价格在 200 周均线或全网平均成本之下）。" : `跌破 200 周均线或 MVRV < 1（现在约 ${fmtUsd(reservePrice)}）时买。`}
            可能要等很久：跌破 200 周均线历史上两次之间最长隔了 4 年（2022-06 到 2026-06）。
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- three paths

function pathTitle(s: ScenarioResult) {
  if (s.key === "top") return `头仓就是底，之后涨到 ${fmtUsd(s.end)}`;
  if (s.key === "mid") return `跌到 ${fmtUsd(s.bottom)}，再回到 ${fmtUsd(s.end)}`;
  return `一路跌到最低预期价 ${fmtUsd(s.bottom)}`;
}

function Paths({ paths, budget, weeks }: { paths: ScenarioResult[]; budget: number; weeks: number }) {
  const crash = paths.find((p) => p.key === "crash");
  const lumpLoss = crash ? ((crash.lumpBtc * crash.bottom) / budget - 1) * 100 : null;
  const cell = (btc: number, best: boolean) => (
    <td className="py-1.5 pr-2 text-right">
      <b className={best ? "text-up" : "text-ink"}>{fmtBtc(btc)}</b>
      <span className="block text-[11px] text-ink-3">均价 {fmtUsd(budget / btc)}</span>
    </td>
  );
  return (
    <div>
      <h3 className="mb-1.5 text-[14px] font-semibold">三种走势下能攒多少币</h3>
      {/* phones: one card per path */}
      <ul className="num space-y-1.5 sm:hidden">
        {paths.map((s) => {
          const best = Math.max(s.btc, s.lumpBtc, s.pureDcaBtc);
          const col = (label: string, btc: number) => (
            <div className="min-w-0 rounded-md bg-panel-2 px-2 py-1">
              <div className="text-[11px] text-ink-3">{label}</div>
              <b className={btc === best ? "text-up" : "text-ink"}>{fmtBtc(btc)}</b>
              <div className="text-[10px] text-ink-3">均价 {fmtUsd(budget / btc)}</div>
            </div>
          );
          return (
            <li key={s.key} className="rounded-lg border border-line px-3 py-2 text-[12px] leading-relaxed">
              <div className="text-ink">{pathTitle(s)}</div>
              <div className="text-[11px] text-ink-3">
                限价梯成交 {s.ladderFilled} 档{s.fomo ? " · 防踏空启动" : ""} · 预备金{s.reserveAt === "trigger" ? "触发" : s.reserveAt === "end" ? "到期买入" : "无"}
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1.5">
                {col("这个计划", s.btc)}
                {col("一次性买入", s.lumpBtc)}
                {col(`定投 ${weeks} 周`, s.pureDcaBtc)}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="-mx-1 hidden overflow-x-auto px-1 sm:block">
        <table className="num w-full min-w-[520px] text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-ink-3">
              <th className="py-1.5 pr-2 font-normal">假设的走势</th>
              <th className="py-1.5 pr-2 text-right font-normal">这个计划</th>
              <th className="py-1.5 pr-2 text-right font-normal">今天一次性买入</th>
              <th className="py-1.5 pr-2 text-right font-normal">每周定投 {weeks} 周</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {paths.map((s) => {
              const best = Math.max(s.btc, s.lumpBtc, s.pureDcaBtc);
              return (
                <tr key={s.key}>
                  <td className="py-1.5 pr-2 text-ink-2">
                    {pathTitle(s)}
                    <span className="block text-[11px] text-ink-3">
                      限价梯成交 {s.ladderFilled} 档{s.fomo ? " · 防踏空启动" : ""} · 预备金{s.reserveAt === "trigger" ? "触发" : s.reserveAt === "end" ? "到期买入" : "无"}
                    </span>
                  </td>
                  {cell(s.btc, s.btc === best)}
                  {cell(s.lumpBtc, s.lumpBtc === best)}
                  {cell(s.pureDcaBtc, s.pureDcaBtc === best)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {crash && (
        <p className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] leading-relaxed text-ink">
          跌到 {fmtUsd(crash.bottom)} 时，这个计划账面浮亏约 <b className="num">{Math.abs(crash.pnlAtBottomPct).toFixed(0)}%</b>
          {lumpLoss != null && <>（一次性买入约 {Math.abs(lumpLoss).toFixed(0)}%）</>}，你要提前知道自己能不能拿住。
        </p>
      )}
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
        三条走势都是假设的直线（期限的前三分之一走到最低点，之后走到终点），不是预测。绿色是三种做法里攒币最多的：没有哪种分法能同时做到“不买在高点”和“不踏空”，计划是让你事先选好更能接受哪种后悔。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- history replay

function Replay({ rep, pending }: { rep: ReturnType<typeof replay>; pending: boolean }) {
  const m = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)} 倍`);
  return (
    <div className={pending ? "opacity-60 transition-opacity" : undefined}>
      <h3 className="mb-1.5 text-[14px] font-semibold">历史回放：每一天都当作起点</h3>
      {!rep ? (
        <p className="text-[13px] text-ink-3">历史不够长，算不了回放。</p>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-ink-2">
            {rep.from.slice(0, 4)} 年以来 <b className="num text-ink">{rep.starts.toLocaleString("en-US")}</b> 个起点，按这套计划攒到的币是每周定投的 <b className="num text-ink">中位 {m(rep.vsDca.median)}</b>（最差 10% {m(rep.vsDca.p10)}，最好 10% {m(rep.vsDca.p90)}），是一次性买入的{" "}
            <b className="num text-ink">中位 {m(rep.vsLump.median)}</b>（最差 10% {m(rep.vsLump.p10)}，最好 10% {m(rep.vsLump.p90)}）。
          </p>
          <div className="-mx-1 mt-2 overflow-x-auto px-1">
            <table className="num w-full text-[12px]">
              <thead>
                <tr className="border-b border-line text-left text-ink-3">
                  <th className="py-1.5 pr-2 font-normal">起点在</th>
                  <th className="py-1.5 pr-2 text-right font-normal">起点数</th>
                  <th className="py-1.5 pr-2 text-right font-normal">对每周定投<span className="hidden sm:inline">（中位）</span></th>
                  <th className="py-1.5 pr-2 text-right font-normal">对一次性<span className="hidden sm:inline">买入（中位）</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rep.vsDca.periods.map((p, k) => (
                  <tr key={p.label}>
                    <td className="py-1.5 pr-2">{p.label}</td>
                    <td className="py-1.5 pr-2 text-right">{p.n.toLocaleString("en-US")}</td>
                    <td className="py-1.5 pr-2 text-right">{m(p.median)}</td>
                    <td className="py-1.5 pr-2 text-right">{m(rep.vsLump.periods[k].median)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 rounded-lg bg-panel-2 px-3 py-2 text-[13px] leading-relaxed text-ink">
            没有哪种分法能证明比每周定投多攒币（E23）。这套计划的作用是跌深了有钱买、涨了不至于踏空。
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            限价单只按日线收盘判断成交，真实挂单在影线上就能成交。回放时头仓价按“头仓价 ÷ 现价”的比例放到每个起点上，各档保持同样的间距；起点到 {rep.to} 为止，后面的日子不够走完期限。
          </p>
        </>
      )}
    </div>
  );
}

