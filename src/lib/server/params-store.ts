import { getDb } from "./db.ts";
import { diffFromDefaults, engineParams, type EngineParams, type ParamValues } from "../params.ts";

/**
 * Versioned engine parameters. Every save inserts a new row holding only
 * the values that differ from the code defaults; the newest row is current.
 * Version 0 means "all defaults".
 */

export interface ParamsVersion {
  id: number;
  createdAt: number;
  author: string;
  note: string | null;
  values: ParamValues;
}

let cached: { version: number; values: ParamValues; engine: EngineParams } | null = null;

function rowToVersion(r: { id: number; created_at: number; author: string; note: string | null; data: string }): ParamsVersion {
  return { id: r.id, createdAt: r.created_at, author: r.author, note: r.note, values: JSON.parse(r.data) };
}

export function currentParams(): { version: number; values: ParamValues; engine: EngineParams } {
  if (cached) return cached;
  let row: { id: number; created_at: number; author: string; note: string | null; data: string } | undefined;
  try {
    row = getDb().prepare("SELECT * FROM params_versions ORDER BY id DESC LIMIT 1").get() as typeof row;
  } catch {
    row = undefined; // no database (tests, scripts): use defaults
  }
  const values = row ? rowToVersion(row).values : {};
  cached = { version: row?.id ?? 0, values, engine: engineParams(values) };
  return cached;
}

export function saveParams(values: ParamValues, author: string, note: string | null): ParamsVersion {
  const data = diffFromDefaults(values);
  const now = Date.now();
  const id = Number(getDb().prepare("INSERT INTO params_versions (created_at, author, note, data) VALUES (?, ?, ?, ?)").run(now, author, note, JSON.stringify(data)).lastInsertRowid);
  cached = null;
  return { id, createdAt: now, author, note, values: data };
}

export function listParamVersions(limit = 50): ParamsVersion[] {
  return (getDb().prepare("SELECT * FROM params_versions ORDER BY id DESC LIMIT ?").all(limit) as Parameters<typeof rowToVersion>[0][]).map(rowToVersion);
}

export function getParamVersion(id: number): ParamsVersion | null {
  const r = getDb().prepare("SELECT * FROM params_versions WHERE id = ?").get(id) as Parameters<typeof rowToVersion>[0] | undefined;
  return r ? rowToVersion(r) : null;
}
