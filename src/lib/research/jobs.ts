import { currentParams } from "../server/params-store.ts";
import { defendReport } from "./defend.ts";
import { levelsReport } from "./levels.ts";
import { plansReport } from "./plans.ts";
import { lightReport, pruneReports, saveReport, signalsReport } from "./run.ts";
import { watchReport } from "./watch.ts";

/** Weekly: every report on the current engine parameters, saved for the admin page. */
export async function runResearch() {
  const t0 = Date.now();
  const { engine, version } = currentParams();
  const signals = await signalsReport(engine, { paramsVersion: version });
  const light = lightReport(engine, { paramsVersion: version });
  const levels = await levelsReport(engine, { paramsVersion: version });
  const plans = await plansReport(engine, { paramsVersion: version });
  const defend = await defendReport(engine, { paramsVersion: version });
  const watch = await watchReport(engine, { paramsVersion: version });
  const ids = [saveReport(signals), saveReport(light), saveReport(levels), saveReport(plans), saveReport(defend), saveReport(watch)];
  pruneReports();
  const count = (rows: { verdict: string }[], v: string) => rows.filter((r) => r.verdict === v).length;
  return {
    ids,
    signals: { rows: signals.rows.length, better: count(signals.rows, "有优势"), worse: count(signals.rows, "比随机差") },
    light: { rows: light.rows.length, better: count(light.rows, "有优势"), worse: count(light.rows, "比随机差") },
    levels: { rows: levels.rows.length, better: count(levels.rows, "有优势"), worse: count(levels.rows, "比随机差") },
    plans: { rows: plans.rows.length, better: count(plans.rows, "有优势"), worse: count(plans.rows, "比随机差") },
    defend: { rows: defend.rows.length, better: count(defend.rows, "有优势"), worse: count(defend.rows, "比随机差") },
    watch: { rows: watch.rows.length, better: count(watch.rows, "有优势"), worse: count(watch.rows, "比随机差") },
    durationMs: Date.now() - t0,
  };
}
