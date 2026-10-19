import { getDb } from "./db.ts";
import { CATEGORIES, LEVELS, type Level, type LogCategory } from "./log.ts";

/** Filtering, paging and batch iteration over the `logs` table. */

export interface LogFilter {
  from?: number;
  to?: number;
  levels?: Level[];
  categories?: LogCategory[];
  q?: string;
  trace?: string;
  /** cursor: return rows with id < beforeId */
  beforeId?: number;
  limit?: number;
}

export interface LogRow {
  id: number;
  ts: number;
  level: Level;
  category: LogCategory;
  msg: string;
  trace: string | null;
  duration_ms: number | null;
  ctx: string | null;
}

const escLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function parseFilter(sp: URLSearchParams): LogFilter {
  const num = (k: string) => {
    const v = Number(sp.get(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const list = <T extends string>(k: string, allowed: readonly T[]) =>
    (sp.get(k) || "")
      .split(",")
      .filter((x): x is T => (allowed as readonly string[]).includes(x));
  return {
    from: num("from"),
    to: num("to"),
    levels: list("level", LEVELS),
    categories: list("category", CATEGORIES),
    q: sp.get("q")?.trim().slice(0, 200) || undefined,
    trace: sp.get("trace")?.trim().slice(0, 32) || undefined,
    beforeId: num("before"),
    limit: Math.min(500, num("limit") ?? 100),
  };
}

function where(f: LogFilter) {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (f.from) parts.push("ts >= ?"), params.push(f.from);
  if (f.to) parts.push("ts <= ?"), params.push(f.to);
  if (f.levels?.length) parts.push(`level IN (${f.levels.map(() => "?").join(",")})`), params.push(...f.levels);
  if (f.categories?.length) parts.push(`category IN (${f.categories.map(() => "?").join(",")})`), params.push(...f.categories);
  if (f.trace) parts.push("trace = ?"), params.push(f.trace);
  if (f.q) {
    const like = `%${escLike(f.q)}%`;
    parts.push("(msg LIKE ? ESCAPE '\\' OR ctx LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

export function queryLogs(f: LogFilter): { rows: LogRow[]; nextBefore: number | null } {
  const w = where(f);
  const extra = f.beforeId ? `${w.sql ? `${w.sql} AND` : "WHERE"} id < ?` : w.sql;
  const params = f.beforeId ? [...w.params, f.beforeId] : w.params;
  const limit = f.limit ?? 100;
  const rows = getDb()
    .prepare(`SELECT id, ts, level, category, msg, trace, duration_ms, ctx FROM logs ${extra} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit + 1) as LogRow[];
  const more = rows.length > limit;
  if (more) rows.pop();
  return { rows, nextBefore: more ? rows[rows.length - 1].id : null };
}

export function countLogs(f: LogFilter): number {
  const w = where(f);
  return (getDb().prepare(`SELECT COUNT(*) n FROM logs ${w.sql}`).get(...w.params) as { n: number }).n;
}

/** Oldest-first batches for export/archiving, so memory stays flat. */
export function* iterateLogs(f: LogFilter, batch = 5000): Generator<LogRow[]> {
  const w = where(f);
  const stmt = getDb().prepare(`SELECT id, ts, level, category, msg, trace, duration_ms, ctx FROM logs ${w.sql ? `${w.sql} AND` : "WHERE"} id > ? ORDER BY id ASC LIMIT ?`);
  let after = 0;
  for (;;) {
    const rows = stmt.all(...w.params, after, batch) as LogRow[];
    if (rows.length === 0) return;
    yield rows;
    after = rows[rows.length - 1].id;
  }
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const isoLocal = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export const CSV_HEADER = "时间,级别,分类,消息,追踪ID,耗时ms,上下文\n";
export const toCsvLine = (r: LogRow) => [isoLocal(r.ts), r.level, r.category, r.msg, r.trace, r.duration_ms, r.ctx].map(csvCell).join(",") + "\n";
function parseCtx(ctx: string | null): unknown {
  if (!ctx) return null;
  try {
    return JSON.parse(ctx);
  } catch {
    return ctx; // truncated entries are kept as text
  }
}

export const toJsonLine = (r: LogRow) => JSON.stringify({ ...r, time: new Date(r.ts).toISOString(), ctx: parseCtx(r.ctx) }) + "\n";
