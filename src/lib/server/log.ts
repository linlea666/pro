import { getDb } from "./db.ts";
import { currentTrace } from "./context.ts";
import { env } from "./env.ts";

/**
 * Structured logger. Every entry goes to stdout (journald) and, from the
 * configured level up, to the `logs` table for the admin log center.
 */

export type Level = "debug" | "info" | "warn" | "error";
export type LogCategory = "datasource" | "engine" | "ai" | "http" | "audit" | "system" | "client";

export const LEVELS: Level[] = ["debug", "info", "warn", "error"];
export const CATEGORIES: LogCategory[] = ["datasource", "engine", "ai", "http", "audit", "system", "client"];
const rank = (l: Level) => LEVELS.indexOf(l);

export interface LogFields {
  durationMs?: number;
  trace?: string;
  [k: string]: unknown;
}

let insert: ((row: unknown[]) => void) | null | undefined;

function writer() {
  if (insert !== undefined) return insert;
  try {
    const stmt = getDb().prepare("INSERT INTO logs (ts, level, category, msg, trace, duration_ms, ctx) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert = (row) => stmt.run(row);
  } catch (e) {
    console.error("[log] database unavailable, logging to stdout only:", (e as Error).message);
    insert = null;
  }
  return insert;
}

function safeJson(v: unknown) {
  try {
    const s = JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack?.split("\n").slice(0, 6).join("\n") } : x));
    return s.length > 8000 ? s.slice(0, 8000) + "…" : s;
  } catch {
    return '"[unserializable]"';
  }
}

export function log(level: Level, category: LogCategory, msg: string, fields: LogFields = {}) {
  if (rank(level) < rank(env.logLevel)) return;
  const { durationMs, trace: t, ...raw } = fields;
  const ctx = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const trace = t ?? currentTrace() ?? null;
  const ts = Date.now();
  const hasCtx = Object.keys(ctx).length > 0;
  const line = `[${level}] [${category}]${trace ? ` [${trace}]` : ""} ${msg}${durationMs != null ? ` (${durationMs}ms)` : ""}${hasCtx ? " " + safeJson(ctx) : ""}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  try {
    writer()?.([ts, level, category, msg.slice(0, 1000), trace, durationMs ?? null, hasCtx ? safeJson(ctx) : null]);
  } catch (e) {
    console.error("[log] write failed:", (e as Error).message);
  }
}

export const logger = {
  debug: (c: LogCategory, m: string, f?: LogFields) => log("debug", c, m, f),
  info: (c: LogCategory, m: string, f?: LogFields) => log("info", c, m, f),
  warn: (c: LogCategory, m: string, f?: LogFields) => log("warn", c, m, f),
  error: (c: LogCategory, m: string, f?: LogFields) => log("error", c, m, f),
};
