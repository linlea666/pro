/**
 * Server-side maintenance CLI (run through the `signallight` wrapper):
 *   migrate                       apply database migrations
 *   admin [--user NAME] [--password PASS]
 *                                 create or reset an admin; prints a generated password if none given
 *   backup [--label NAME]         back up the database now
 *   restore FILE                  replace the database with a backup (service must be stopped)
 *   info                          print database path, schema version, admin count
 *   history [--sync] [--coin BTC] [--tf 1h]
 *                                 local candle history per coin/timeframe; --sync fills it now (candles,
 *                                 taker volume, mark prices and the open-interest archive)
 *   research [--kind signals|light|levels|plans|defend|watch|patterns] [--all]
 *                                 generate the research reports, save them and print the findings (--all: every row)
 *   reports [--all]               print the newest saved report of each kind (read-only; diagnose uses it)
 *   compare --set KEY=VALUE [--set ...] [--tf 1h] [--coin BTC] [--step 2]
 *                                 replay the traffic light with the current and the changed parameters on the
 *                                 same past moments and print both records against the random control
 *   plan [--coin BTC] [--fw 4h|1d] [--at "2026-09-23 20:00"]
 *                                 the trend map and both trading plans now, or as they stood when the bar
 *                                 opening at --at (Beijing time unless a zone is given) closed, with what came next
 *   watch [--coin BTC] [--at "2026-10-15 21:00"]
 *                                 the key-level watch now, or at the close of the 15-minute bar containing --at
 *                                 (Beijing time unless a zone is given): both sides' state, the levels, the signs
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { dbPath, getDb, migrate, SCHEMA_VERSION } from "../src/lib/server/db.ts";
import { adminCount, upsertAdmin, validatePassword } from "../src/lib/server/auth.ts";
import { backupNow } from "../src/lib/server/jobs.ts";
import type { ResearchReport } from "../src/lib/research/run.ts";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

function genPassword() {
  // letters + digits, always passes validatePassword
  const base = randomBytes(12).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return `${base}${(randomBytes(1)[0] % 90) + 10}a`;
}

/** One research report as the `research` command prints it: coverage, then a row per finding (all: every row). */
function printReport(r: ResearchReport, id: number, all: boolean) {
  const f = (g: { edgeR: number | null; n: number }) => (g.edgeR == null ? "    —" : `${g.edgeR >= 0 ? "+" : ""}${g.edgeR.toFixed(2)}`.padStart(5));
  console.log(`\n${r.title}（报告 #${id}，用时 ${Math.round(r.durationMs / 1000)} 秒，样本外从 ${new Date(r.holdoutFrom * 1000).toISOString().slice(0, 10)} 起）`);
  for (const c of r.coverage) console.log(`  ${c.tf}：${c.coins} 个币，${c.bars}${r.kind === "light" ? " 个时点" : " 根/币"}，${new Date((c.from ?? 0) * 1000).toISOString().slice(0, 10)} 至 ${new Date((c.to ?? 0) * 1000).toISOString().slice(0, 10)}`);
  console.log("  周期 信号                      笔数  样本内 样本外   BTC   ETH  前半  后半  q值     结论");
  for (const x of r.rows) {
    if (!all && x.verdict !== "有优势" && x.verdict !== "比随机差" && !["light", "level", "level_mfe", "exit", "entry", "behavior", "anchor", "stop", "defend", "stop2", "watch", "watch_sign", "move24", "pa"].includes(x.family)) continue;
    const c = x.cells;
    const e = x.extra ?? {};
    const watch = () => {
      const p: string[] = [];
      if (e.triggerPct != null) p.push(`触发 ${e.triggerPct}%`);
      if (e.halfwayPct != null) p.push(`接到半山腰 ${e.halfwayPct}%${e.halfwayA != null ? `（碰到就进 ${e.halfwayA}%，差 ${e.halfwayDiff} 个百分点，p ${e.halfwayP ?? "—"}，q ${e.halfwayQ ?? "—"}${e.halfwayConsistent ? "，方向一致" : "，方向不一"}）` : ""}`);
      if (e.quickStopPct != null) p.push(`24 小时内被扫 ${e.quickStopPct}%${e.quickStopA != null ? `（碰到就进 ${e.quickStopA}%）` : ""}`);
      if (e.missedPct != null) p.push(`错过 ${e.missedPct}%`);
      if (e.volRatio != null) p.push(`${e.events} 次，之后波动是平时的 ${e.volRatio} 倍`);
      if (e.unknown) p.push(`${e.unknown} 笔数据缺失未计`);
      return p.length ? `  ${p.join("  ")}  均值 ${c.is.meanR}R` : "";
    };
    const pa = () =>
      `  ${e.setups != null ? `${e.setups} 个形态、触发 ${e.triggerPct ?? "—"}%  ` : ""}${e.trades} 笔  先到 2R ${e.reach2 ?? "—"}%  6 根内被扫 ${e.quickStopPct ?? "—"}%  风险中位 ${e.riskAtrMed ?? "—"} 倍 ATR  均值 ${c.is.meanR}R`;
    const lv =
      x.family === "pa"
        ? pa()
        : x.family === "watch" || x.family === "watch_sign" || x.family === "move24"
        ? watch()
        : x.family === "level"
        ? `  刺穿 ${e.piercedPct}% 失效 ${e.brokenPct}%  均值 ${c.is.meanR}R`
        : x.family === "level_mfe"
          ? `  止损前先到 2R ${e.reach2}%（随机 ${e.reach2Ctl}%） 最远中位 ${e.mfeMedR}R  均值 ${c.is.meanR}R`
          : e.stopPct != null
            ? `  被扫 ${e.stopPct}%（${e.quickStopPct}% 在 6 根内） 先到 2R ${e.reach2}%  均值 ${c.is.meanR}R`
            : "";
    console.log(`  ${x.tf.padEnd(4)} ${x.name.padEnd(22)} ${String(c.is.n).padStart(5)} ${f(c.is)}  ${f(c.oos)} ${f(c.btc)} ${f(c.eth)} ${f(c.firstHalf)} ${f(c.secondHalf)}  ${String(x.q ?? "—").padEnd(6)}  ${x.verdict}${lv}${x.control ? `（对照：${x.control}）` : ""}`);
  }
}

async function main() {
  switch (cmd) {
    case "migrate": {
      const d = getDb(); // getDb() migrates on open
      const r = migrate(d);
      console.log(`数据库结构已是最新：v${r.to}（${dbPath()}）`);
      break;
    }
    case "admin": {
      const user = opt("user") || "admin";
      const given = opt("password");
      const password = given || genPassword();
      const bad = validatePassword(password);
      if (bad) throw new Error(bad);
      upsertAdmin(user, password);
      console.log(`管理员已就绪：用户名 ${user}`);
      if (!given) console.log(`初始密码：${password}  （登录后请到“系统设置”修改）`);
      break;
    }
    case "backup": {
      const file = await backupNow(opt("label") || "manual");
      console.log(`已备份：${file}`);
      break;
    }
    case "restore": {
      const file = rest[0];
      if (!file || !fs.existsSync(file)) throw new Error("请指定存在的备份文件");
      for (const f of [dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`]) fs.rmSync(f, { force: true });
      fs.copyFileSync(file, dbPath());
      console.log(`已从 ${file} 恢复数据库`);
      break;
    }
    case "info": {
      getDb();
      console.log(JSON.stringify({ db: dbPath(), schema: SCHEMA_VERSION, admins: adminCount() }, null, 2));
      break;
    }
    case "history": {
      const { historyCoverage, syncHistory, HISTORY_TFS } = await import("../src/lib/data/history.ts");
      const { coinIds } = await import("../src/lib/server/coins.ts");
      const coins = opt("coin") ? [opt("coin")!.toUpperCase()] : coinIds();
      const tfs = (opt("tf") ? [opt("tf")] : HISTORY_TFS) as typeof HISTORY_TFS;
      if (rest.includes("--sync")) {
        for (;;) {
          const r = await syncHistory({ coins, tfs, budgetMs: 60_000 });
          console.log(`补充 K 线：请求 ${r.requests} 次，向前补 ${r.added} 根，补缺口 ${r.filled} 根${r.error ? `，出错：${r.error}` : ""}`);
          if (r.complete || r.error || !r.requests) break;
        }
        const { MARK_SOURCE } = await import("../src/lib/data/klines.ts");
        for (;;) {
          const r = await syncHistory({ source: MARK_SOURCE, budgetMs: 60_000 });
          console.log(`标记价格：请求 ${r.requests} 次，补 ${r.added} 根，补缺口 ${r.filled} 根${r.error ? `，出错：${r.error}` : ""}`);
          if (r.complete || r.error || !r.requests) break;
        }
        const { syncOpenInterestArchive } = await import("../src/lib/data/archive.ts");
        for (;;) {
          const r = await syncOpenInterestArchive({ coins, budgetMs: 60_000, concurrency: 3 });
          console.log(`持仓量归档：请求 ${r.requests} 次，补 ${r.days} 天（${r.rows} 小时）${r.error ? `，出错：${r.error}` : ""}`);
          if (r.complete || r.error || !r.requests) break;
        }
      }
      const day = (t: number | null) => (t == null ? "-" : new Date(t * 1000).toISOString().slice(0, 10));
      console.log("周期  币种   根数     最早        最新        目标        状态");
      for (const c of historyCoverage(undefined, coins, tfs)) {
        const status = !c.bars
          ? "未开始"
          : c.complete
            ? c.exchangeStart != null && c.first === c.exchangeStart
              ? "完整（交易所最早）"
              : "完整"
            : c.gaps
              ? `有 ${c.gaps} 处缺口待补`
              : c.tbvPending
                ? `补主动买入量中（还剩 ${c.tbvPending} 根）`
                : "补充中";
        const holes = c.exchangeHoles ? `，交易所缺 ${c.exchangeHoles} 段` : "";
        console.log(
          `${c.tf.padEnd(5)} ${c.coin.padEnd(6)} ${String(c.bars).padStart(6)}   ${day(c.first)}  ${day(c.last)}  ${c.target ? day(c.target) : "全部".padEnd(10)}  ${status}${holes}`,
        );
      }
      const { MARK_SERIES } = await import("../src/lib/data/history.ts");
      console.log("\n标记价格（研究用，判断止损是否真的被触发）：");
      for (const c of historyCoverage(undefined, MARK_SERIES.coins, MARK_SERIES.tfs, "binance-mark")) {
        console.log(`  ${c.tf.padEnd(4)} ${c.coin.padEnd(5)} ${String(c.bars).padStart(6)} 根  ${day(c.first)} 至 ${day(c.last)}  ${c.complete ? "完整" : "补充中"}`);
      }
      const { openInterestCoverage } = await import("../src/lib/data/archive.ts");
      console.log("\n持仓量（每小时；更早的部分来自 Binance 公开数据归档）：");
      for (const c of openInterestCoverage(coins)) {
        console.log(`  ${c.coin.padEnd(5)} ${String(c.n).padStart(6)} 小时  ${day(c.first)} 至 ${day(c.last)}  ${c.done ? "归档已补齐" : "归档补充中"}`);
      }
      break;
    }
    case "research": {
      const { currentParams } = await import("../src/lib/server/params-store.ts");
      const { lightReport, saveReport, signalsReport } = await import("../src/lib/research/run.ts");
      const { levelsReport } = await import("../src/lib/research/levels.ts");
      const { plansReport } = await import("../src/lib/research/plans.ts");
      const { defendReport } = await import("../src/lib/research/defend.ts");
      const { watchReport } = await import("../src/lib/research/watch.ts");
      const { patternsReport } = await import("../src/lib/research/patterns.ts");
      const { engine, version } = currentParams();
      const kind = opt("kind");
      const reports = [];
      if (!kind || kind === "light") reports.push(lightReport(engine, { paramsVersion: version }));
      if (!kind || kind === "signals") reports.push(await signalsReport(engine, { paramsVersion: version }));
      if (!kind || kind === "levels") reports.push(await levelsReport(engine, { paramsVersion: version }));
      if (!kind || kind === "plans") reports.push(await plansReport(engine, { paramsVersion: version }));
      if (!kind || kind === "defend") reports.push(await defendReport(engine, { paramsVersion: version }));
      if (!kind || kind === "watch") reports.push(await watchReport(engine, { paramsVersion: version }));
      if (!kind || kind === "patterns") reports.push(await patternsReport(engine, { paramsVersion: version }));
      for (const r of reports) printReport(r, saveReport(r), rest.includes("--all"));
      console.log("\n优势单位 R（1R = 入场时 1 倍 ATR），已扣成本，对比同期随机对照。");
      break;
    }
    case "reports": {
      // read-only: the newest saved report of each kind (used by diagnose)
      const { getReport } = await import("../src/lib/research/run.ts");
      const { currentParams } = await import("../src/lib/server/params-store.ts");
      const { version } = currentParams();
      const kinds = ["light", "signals", "levels", "plans", "defend", "watch", "patterns"] as const;
      for (const kind of kinds) {
        const r = getReport(undefined, kind);
        if (!r) {
          console.log(`\n${kind}：还没有生成过`);
          continue;
        }
        const count: Record<string, number> = {};
        for (const x of r.rows) count[x.verdict] = (count[x.verdict] ?? 0) + 1;
        const age = Math.round((Date.now() - r.createdAt) / 86400_000);
        console.log(`\n—— ${kind}：生成于 ${new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC（${age} 天前），参数版本 ${r.paramsVersion}${r.paramsVersion === version ? "" : `（当前 ${version}，不一致）`}，数据源 ${r.source}，${r.rows.length} 行：${Object.entries(count).map(([k, n]) => `${k} ${n}`).join("，")}`);
        if (r.rules) console.log(`  规则：${JSON.stringify(r.rules)}`);
        printReport(r, r.id, rest.includes("--all"));
        for (const n of r.notes) console.log(`  注：${n}`);
      }
      break;
    }
    case "compare": {
      const { currentParams } = await import("../src/lib/server/params-store.ts");
      const { engineParams, validateParams, DEFAULT_PARAMS } = await import("../src/lib/params.ts");
      const { compareEngines } = await import("../src/lib/research/compare.ts");
      const changes: Record<string, number | boolean> = {};
      rest.forEach((x, i) => {
        if (rest[i - 1] !== "--set") return;
        const [k, v] = x.split("=");
        changes[k] = v === "true" ? true : v === "false" ? false : Number(v);
      });
      if (!Object.keys(changes).length) throw new Error("请用 --set 参数=值 指定要对比的改动，例如 --set verdict.familyVotes=true");
      const cur = currentParams();
      const next = { ...DEFAULT_PARAMS, ...cur.values, ...changes };
      const err = validateParams(next);
      if (err) throw new Error(err);
      const r = await compareEngines(cur.engine, engineParams(next), {
        tfs: opt("tf") ? [opt("tf") as "1h"] : undefined,
        coins: opt("coin") ? [opt("coin")!.toUpperCase()] : undefined,
        step: Number(opt("step") || 1),
        onProgress: (n, total) => process.stderr.write(`\r回放 ${n}/${total}`),
      });
      process.stderr.write("\n");
      console.log(`对比 ${JSON.stringify(changes)}：${r.points} 个时点，${r.changedPct}% 的时点灯色变了，用时 ${Math.round(r.durationMs / 1000)} 秒`);
      const f = (g: { edgeR: number | null }) => (g.edgeR == null ? "    —" : `${g.edgeR >= 0 ? "+" : ""}${g.edgeR.toFixed(2)}`.padStart(5));
      console.log("  周期 灯色                     笔数  样本内 样本外   BTC   ETH  前半  后半  结论");
      for (const [label, rows] of [["改前", r.before], ["改后", r.after]] as const) {
        console.log(`${label}：`);
        for (const x of rows) {
          const c = x.cells;
          console.log(`  ${x.tf.padEnd(4)} ${x.name.padEnd(22)} ${String(c.is.n).padStart(5)} ${f(c.is)}  ${f(c.oos)} ${f(c.btc)} ${f(c.eth)} ${f(c.firstHalf)} ${f(c.secondHalf)}  ${x.verdict}`);
        }
      }
      console.log("\n优势单位 R（1R = 入场时 1 倍 ATR），已扣成本，对比同期全部时点。按工作约定，改后至少好 0.1R、BTC/ETH 和前后两半方向一致才可以上线。");
      break;
    }
    case "plan": {
      const { currentParams } = await import("../src/lib/server/params-store.ts");
      const { computeTrendPlan, FRAMEWORKS } = await import("../src/lib/trendplan.ts");
      const { TF_SECONDS } = await import("../src/lib/types.ts");
      const coin = (opt("coin") ?? "BTC").toUpperCase();
      const fw = (opt("fw") ?? "4h") as "4h" | "1d";
      if (!(fw in FRAMEWORKS)) throw new Error("--fw 只能是 4h 或 1d");
      const at = opt("at");
      // a time without a zone is Beijing time, as people quote it
      const atSec = at ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(" ", "T")}+08:00`) / 1000 : null;
      if (at && !Number.isFinite(atSec)) throw new Error(`看不懂的时间：${at}，例如 --at "2026-09-23 20:00"`);
      const tf = FRAMEWORKS[fw].tf;
      const end = atSec == null ? null : Math.floor(atSec / TF_SECONDS[tf]) * TF_SECONDS[tf] + TF_SECONDS[tf];
      const p = await computeTrendPlan(coin, fw, currentParams().engine, end);
      const bj = (t: number | null) => (t == null ? "—" : new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " "));
      const fp = (x: number | null | undefined) => (x == null ? "—" : x >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Math.round(x * 100) / 100));
      console.log(`${coin} ${fw === "4h" ? "日线定方向、4 小时入场" : "周线定方向、日线入场"}：${bj(p.lastClosedT)} 那根 ${tf} K 线收盘（北京时间）`);
      console.log(`收盘价 ${fp(p.closedPrice)}，ATR ${fp(p.atr)}，数据源 ${p.source}${p.calibrated ? "" : "，缓冲用默认值"}`);
      console.log(`\n${p.headline}\n${p.bias}`);
      for (const m of p.map) console.log(`  ${m.tf.padEnd(3)} ${m.view.label}：${m.view.position}`);
      for (const s of [p.long, p.short]) {
        console.log(`\n【${s.side === "long" ? "多" : "空"}】${s.headline}`);
        if (s.trigger) console.log(`  触发：${s.trigger}`);
        if (s.invalidation && s.entry != null) {
          const v = s.invalidation;
          console.log(`  入场 ${fp(s.entry)}，认错区间 ${fp(v.zone[0])}–${fp(v.zone[1])}（锚点 ${fp(v.anchor)}），止损 ${fp(v.stop)}，距离 ${v.distPct}% / ${v.distAtr} 倍 ATR${v.noise != null ? `，噪音碰到的概率 ${v.noise}%` : ""}`);
          console.log(`  沿途关键位：${s.targets.map((x) => `${fp(x.price)}（${x.label}，${x.r}R）`).join("、") || "—"}；仓位 ${s.size === "half" ? "半仓" : "正常"}`);
        }
        if (s.near) console.log(`  近止损 ${fp(s.near.stop)}，距离 ${s.near.distPct}% / ${s.near.distAtr} 倍 ATR${s.near.noise != null ? `，噪音碰到的概率 ${s.near.noise}%` : ""}，成本约 ${s.near.costR}R`);
        else if (s.nearNote) console.log(`  近止损：${s.nearNote}`);
        if (s.nearText) console.log(`  近 / 远止损：${s.nearText}`);
        for (const w of s.warnings) console.log(`  ! ${w}`);
        if (s.evidence) console.log(`  历史同类：${s.evidence.n} 笔，平均 ${s.evidence.meanR}R，对随机 ${s.evidence.edgeR}R，样本外 ${s.evidence.oosEdgeR}R，${s.evidence.verdict}`);
        const o = p.replay?.[s.side];
        const res = (x: { status: string; r: number; exit: string | null; exitT: number | null; mfe: number | null }) =>
          x.status === "open" ? `仍持有，按最后收盘 ${x.r}R` : `${bj(x.exitT)} ${x.exit === "stop" ? "移动认错位离场" : "到期离场"}，${x.r}R（最多浮盈 ${x.mfe}R）`;
        if (o) {
          console.log(o.status === "none" ? `  之后：${o.watchBars} 根 K 线内没有触发` : `  之后：${bj(o.entryT)} 以 ${fp(o.entry)} 入场、止损 ${fp(o.stop)}，${res({ status: o.status, r: o.r!, exit: o.exit, exitT: o.exitT, mfe: o.mfe })}`);
          if (o.near) console.log(`        用近止损 ${fp(o.near.stop)}：${res(o.near)}`);
        }
        const d = s.defend;
        if (d) {
          console.log(`  守位做法：${d.text}${d.size === "half" ? "（逆日线，半仓）" : ""}`);
          console.log(`    入场 ${fp(d.entry)}（${bj(d.entryT + TF_SECONDS[tf])} 收盘），远止损 ${fp(d.far.stop)}（${d.far.distAtr} 倍 ATR）${d.near ? `，近止损 ${fp(d.near.stop)}（${d.near.distAtr} 倍 ATR）` : `；${d.nearNote}`}`);
          console.log(`    ${(["flow", "oi", "turn"] as const).map((k) => `${{ flow: "主动成交", oi: "持仓量骤降", turn: "1 小时转强" }[k]} ${d.checks[k] == null ? "数据缺" : d.checks[k] ? "有" : "没有"}`).join("，")}；${d.verdictText}`);
          const od = p.replay?.defend[s.side];
          if (od) console.log(`    之后：远止损 ${res(od.far)}${od.near ? `；近止损 ${res(od.near)}` : ""}`);
        }
        const lines = p.defenses[s.side];
        if (lines.length) console.log(`  防线：${lines.map((x) => `${x.label} ${fp(x.price)}（${x.distAtr} 倍 ATR）`).join("；")}`);
      }
      if (p.scorecard) for (const r of p.scorecard.rows) console.log(`\n成绩单：${r.name}：${r.n} 笔，平均 ${r.meanR}R（随机 ${r.controlR}R），最近 12 个月 ${r.oosN} 笔平均 ${r.oosMeanR}R，${r.verdict}`);
      if (p.scorecard?.warning) console.log(`! ${p.scorecard.warning}`);
      break;
    }
    case "watch": {
      const { currentParams } = await import("../src/lib/server/params-store.ts");
      const { computeWatch, fmtPrice: fp } = await import("../src/lib/watch.ts");
      const coin = (opt("coin") ?? "BTC").toUpperCase();
      const at = opt("at");
      // a time without a zone is Beijing time, as people quote it
      const atSec = at ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(" ", "T")}+08:00`) / 1000 : null;
      if (at && !Number.isFinite(atSec)) throw new Error(`看不懂的时间：${at}，例如 --at "2026-10-15 21:00"`);
      // the close of the 15-minute bar containing that moment
      const end = atSec == null ? null : Math.floor(atSec / 900) * 900 + 900;
      const v = await computeWatch(coin, currentParams().engine, end);
      const bj = (t: number | null | undefined) => (t == null ? "—" : new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " "));
      const STATE = { far: "离得远", near: "靠近", falling: "别接（还在往下打）", watching: "观察（止住了，还没转强）", turned: "已转强" } as const;
      console.log(`${coin} 盯盘：${bj(v.lastClosedT)} 那根 15 分钟 K 线收盘（北京时间）`);
      console.log(`收盘价 ${fp(v.closedPrice)}${v.forming ? `，最新价 ${fp(v.price)}` : ""}，1 小时 ATR ${fp(v.atr1h)}，扫损缓冲 ${v.buf} 倍 ATR${v.calibrated ? "" : "（默认值）"}，数据源 ${v.source}`);
      console.log(`\n${v.headline}`);
      for (const s of [v.long, v.short]) {
        const short = s.dir < 0;
        const state = short ? STATE[s.state].replace("别接（还在往下打）", "别急着空（还在往上冲）").replace("已转强", "已转弱") : STATE[s.state];
        console.log(`\n【${short ? "空（关键高点）" : "多（关键低点）"}】${state}${s.level ? `：${s.level.name} ${fp(s.level.price)}（${s.distAtr} 倍 ATR）` : ""}${s.piercing ? "，正在刺穿" : ""}`);
        const e = s.event;
        if (!e) continue;
        console.log(`  ${bj(e.startT)} 碰到，已过 ${e.bars} 根；最新${short ? "高点" : "低点"} ${fp(e.extreme)}（${bj(e.extremeT)}）${e.bounce != null ? `，${short ? "回落低点" : "反弹高点"} ${fp(e.bounce)}` : ""}${e.reclaimed ? "，扫过后收回" : ""}；第 ${e.attempt} 次等待`);
        console.log(`  创新${short ? "高" : "低"}：${e.newExtremes.map((x) => `${bj(x.t)} ${fp(x.price)}`).join("；")}`);
        if (e.turn) console.log(`  ${bj(e.turn.t)} 15 分钟${short ? "转弱" : "转强"}：入场 ${fp(e.turn.entry)}，止损 ${fp(e.turn.stop)}（${short ? "高点" : "低点"} ${fp(e.turn.extreme)} 之外）`);
        else console.log(`  还没${short ? "转弱" : "转强"}；现在的止损位会在 ${fp(e.stop)}`);
        console.log(`  1 小时${e.hourTurned ? "也已" : "还没"}${short ? "转弱" : "转强"}`);
        for (const g of s.signs ?? []) console.log(`  迹象 ${g.name}：${g.value == null ? "数据缺" : g.value ? "有" : "没有"}${g.text ? `。${g.text}` : ""}`);
      }
      const LS = { none: "", pierced: "，被刺穿·观察", broken: "，失效" } as const;
      console.log(`\n关键位（由近到远）：`);
      for (const l of [...v.levels].sort((x, y) => Math.abs(x.distAtr) - Math.abs(y.distAtr))) console.log(`  ${l.distAtr > 0 ? "上方" : "下方"} ${l.name} ${fp(l.price)}（${l.distAtr} 倍 ATR${LS[l.state]}）`);
      const m = v.move24;
      if (m) {
        console.log(`\n24 小时涨跌 ${m.changePct ?? "—"}%，比历史上 ${m.pctRank ?? "—"}% 的 24 小时波动都大${m.volRatio != null ? `；研究里大涨大跌之后 72 小时的波动是平时的 ${m.volRatio} 倍` : ""}`);
        console.log(`历史最大的日跌幅：${m.topDrops.map((x) => `${bj(x.t).slice(0, 10)} ${x.pct}%`).join("；") || "—"}`);
      }
      console.log(`\n研究：${v.research?.text ?? v.researchNote ?? "—"}`);
      break;
    }
    default:
      console.log("用法：cli.ts migrate | admin [--user 名称] [--password 密码] | backup | restore 文件 | info | history [--sync] | research [--kind …] | compare --set … | plan [--coin BTC] [--at 时间] | watch [--coin BTC] [--at 时间]");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(`错误：${(e as Error).message}`);
  process.exit(1);
});
