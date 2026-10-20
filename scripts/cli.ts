/**
 * Server-side maintenance CLI (run through the `signallight` wrapper):
 *   migrate                       apply database migrations
 *   admin [--user NAME] [--password PASS]
 *                                 create or reset an admin; prints a generated password if none given
 *   backup [--label NAME]         back up the database now
 *   restore FILE                  replace the database with a backup (service must be stopped)
 *   info                          print database path, schema version, admin count
 *   history [--sync] [--coin BTC] [--tf 1h]
 *                                 local candle history per coin/timeframe; --sync fills it now
 *   research [--kind signals|light|levels|plans] [--all]
 *                                 generate the research reports, save them and print the findings (--all: every row)
 *   compare --set KEY=VALUE [--set ...] [--tf 1h] [--coin BTC] [--step 2]
 *                                 replay the traffic light with the current and the changed parameters on the
 *                                 same past moments and print both records against the random control
 *   plan [--coin BTC] [--fw 4h|1d] [--at "2026-09-23 20:00"]
 *                                 the trend map and both trading plans now, or as they stood when the bar
 *                                 opening at --at (Beijing time unless a zone is given) closed, with what came next
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { dbPath, getDb, migrate, SCHEMA_VERSION } from "../src/lib/server/db.ts";
import { adminCount, upsertAdmin, validatePassword } from "../src/lib/server/auth.ts";
import { backupNow } from "../src/lib/server/jobs.ts";

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
      const { COIN_IDS } = await import("../src/lib/symbols.ts");
      const coins = opt("coin") ? [opt("coin")!.toUpperCase()] : COIN_IDS;
      const tfs = (opt("tf") ? [opt("tf")] : HISTORY_TFS) as typeof HISTORY_TFS;
      if (rest.includes("--sync")) {
        for (;;) {
          const r = await syncHistory({ coins, tfs, budgetMs: 60_000 });
          console.log(`补充 K 线：请求 ${r.requests} 次，向前补 ${r.added} 根，补缺口 ${r.filled} 根${r.error ? `，出错：${r.error}` : ""}`);
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
              : "补充中";
        const holes = c.exchangeHoles ? `，交易所缺 ${c.exchangeHoles} 段` : "";
        console.log(
          `${c.tf.padEnd(5)} ${c.coin.padEnd(6)} ${String(c.bars).padStart(6)}   ${day(c.first)}  ${day(c.last)}  ${c.target ? day(c.target) : "全部".padEnd(10)}  ${status}${holes}`,
        );
      }
      break;
    }
    case "research": {
      const { currentParams } = await import("../src/lib/server/params-store.ts");
      const { lightReport, saveReport, signalsReport } = await import("../src/lib/research/run.ts");
      const { levelsReport } = await import("../src/lib/research/levels.ts");
      const { plansReport } = await import("../src/lib/research/plans.ts");
      const { engine, version } = currentParams();
      const kind = opt("kind");
      const reports = [];
      if (!kind || kind === "light") reports.push(lightReport(engine, { paramsVersion: version }));
      if (!kind || kind === "signals") reports.push(await signalsReport(engine, { paramsVersion: version }));
      if (!kind || kind === "levels") reports.push(await levelsReport(engine, { paramsVersion: version }));
      if (!kind || kind === "plans") reports.push(await plansReport(engine, { paramsVersion: version }));
      const f = (g: { edgeR: number | null; n: number }) => (g.edgeR == null ? "    —" : `${g.edgeR >= 0 ? "+" : ""}${g.edgeR.toFixed(2)}`.padStart(5));
      for (const r of reports) {
        const id = saveReport(r);
        console.log(`\n${r.title}（报告 #${id}，用时 ${Math.round(r.durationMs / 1000)} 秒，样本外从 ${new Date(r.holdoutFrom * 1000).toISOString().slice(0, 10)} 起）`);
        for (const c of r.coverage) console.log(`  ${c.tf}：${c.coins} 个币，${c.bars}${r.kind === "light" ? " 个时点" : " 根/币"}，${new Date((c.from ?? 0) * 1000).toISOString().slice(0, 10)} 至 ${new Date((c.to ?? 0) * 1000).toISOString().slice(0, 10)}`);
        console.log("  周期 信号                      笔数  样本内 样本外   BTC   ETH  前半  后半  q值     结论");
        for (const x of r.rows) {
          if (!rest.includes("--all") && x.verdict !== "有优势" && x.verdict !== "比随机差" && !["light", "level", "exit", "entry", "behavior", "anchor", "stop"].includes(x.family)) continue;
          const c = x.cells;
          const lv = x.extra ? `  刺穿 ${x.extra.piercedPct}% 失效 ${x.extra.brokenPct}%  均值 ${c.is.meanR}R` : "";
          console.log(`  ${x.tf.padEnd(4)} ${x.name.padEnd(22)} ${String(c.is.n).padStart(5)} ${f(c.is)}  ${f(c.oos)} ${f(c.btc)} ${f(c.eth)} ${f(c.firstHalf)} ${f(c.secondHalf)}  ${String(x.q ?? "—").padEnd(6)}  ${x.verdict}${lv}${x.control ? `（对照：${x.control}）` : ""}`);
        }
      }
      console.log("\n优势单位 R（1R = 入场时 1 倍 ATR），已扣成本，对比同期随机对照。");
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
        for (const w of s.warnings) console.log(`  ! ${w}`);
        if (s.evidence) console.log(`  历史同类：${s.evidence.n} 笔，平均 ${s.evidence.meanR}R，对随机 ${s.evidence.edgeR}R，样本外 ${s.evidence.oosEdgeR}R，${s.evidence.verdict}`);
        const o = p.replay?.[s.side];
        if (o) {
          console.log(
            o.status === "none"
              ? `  之后：${o.watchBars} 根 K 线内没有触发`
              : `  之后：${bj(o.entryT)} 以 ${fp(o.entry)} 入场、止损 ${fp(o.stop)}，${o.status === "open" ? `仍持有，按最后收盘 ${o.r}R` : `${bj(o.exitT)} ${o.exit === "stop" ? "移动认错位离场" : "到期离场"}，${o.r}R（最多浮盈 ${o.mfe}R）`}`,
          );
        }
      }
      if (p.scorecard) for (const r of p.scorecard.rows) console.log(`\n成绩单：${r.name}：${r.n} 笔，平均 ${r.meanR}R（随机 ${r.controlR}R），最近 12 个月 ${r.oosN} 笔平均 ${r.oosMeanR}R，${r.verdict}`);
      if (p.scorecard?.warning) console.log(`! ${p.scorecard.warning}`);
      break;
    }
    default:
      console.log("用法：cli.ts migrate | admin [--user 名称] [--password 密码] | backup | restore 文件 | info | history [--sync] | research [--kind …] | compare --set … | plan [--coin BTC] [--at 时间]");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(`错误：${(e as Error).message}`);
  process.exit(1);
});
