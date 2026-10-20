import { currentParams } from "../server/params-store.ts";
import { levelsReport } from "./levels.ts";
import { lightReport, pruneReports, saveReport, signalsReport } from "./run.ts";

/** Weekly: both reports on the current engine parameters, saved for the admin page. */
export async function runResearch() {
  const t0 = Date.now();
  const { engine, version } = currentParams();
  const signals = await signalsReport(engine, { paramsVersion: version });
  const light = lightReport(engine, { paramsVersion: version });
  const levels = await levelsReport(engine, { paramsVersion: version });
  const ids = [saveReport(signals), saveReport(light), saveReport(levels)];
  pruneReports();
  const count = (rows: { verdict: string }[], v: string) => rows.filter((r) => r.verdict === v).length;
  return {
    ids,
    signals: { rows: signals.rows.length, better: count(signals.rows, "有优势"), worse: count(signals.rows, "比随机差") },
    light: { rows: light.rows.length, better: count(light.rows, "有优势"), worse: count(light.rows, "比随机差") },
    levels: { rows: levels.rows.length, better: count(levels.rows, "有优势"), worse: count(levels.rows, "比随机差") },
    durationMs: Date.now() - t0,
  };
}
