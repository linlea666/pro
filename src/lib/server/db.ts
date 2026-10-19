import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "./env.ts";

/**
 * Single SQLite database (WAL). Migrations are append-only: add a new entry
 * to MIGRATIONS, never edit an old one. `PRAGMA user_version` tracks progress.
 */

const MIGRATIONS: string[] = [
  // 1: core tables
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    msg TEXT NOT NULL,
    trace TEXT,
    duration_ms INTEGER,
    ctx TEXT
  );
  CREATE INDEX logs_ts ON logs(ts);
  CREATE INDEX logs_cat_ts ON logs(category, ts);
  CREATE INDEX logs_level_ts ON logs(level, ts);
  CREATE INDEX logs_trace ON logs(trace);
  `,
  // 2: engine parameter versions (only overrides of the code defaults are stored)
  `
  CREATE TABLE params_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    author TEXT NOT NULL,
    note TEXT,
    data TEXT NOT NULL
  );
  `,
  // 3: AI interpretations (one per coin/timeframe/bar) and daily usage
  `
  CREATE TABLE ai_cache (
    key TEXT PRIMARY KEY,
    coin TEXT NOT NULL,
    tf TEXT NOT NULL,
    bar_t INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    content TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    duration_ms INTEGER
  );
  CREATE INDEX ai_cache_coin_tf ON ai_cache(coin, tf, created_at);
  CREATE TABLE ai_usage (
    day TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0
  );
  `,
];

let db: Database.Database | null = null;

export function migrate(d: Database.Database) {
  const current = d.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.transaction(() => {
      d.exec(MIGRATIONS[v]);
      d.pragma(`user_version = ${v + 1}`);
    })();
  }
  return { from: current, to: MIGRATIONS.length };
}

export function dbPath() {
  return path.join(/*turbopackIgnore: true*/ env.dataDir, "signallight.db");
}

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(env.dataDir, { recursive: true });
  const d = new Database(dbPath());
  d.pragma("journal_mode = WAL");
  d.pragma("synchronous = NORMAL");
  d.pragma("foreign_keys = ON");
  d.pragma("busy_timeout = 5000");
  migrate(d);
  db = d;
  return d;
}

export const SCHEMA_VERSION = MIGRATIONS.length;
