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
  // 4: local candle history, so refreshes only fetch the newest bars
  `
  CREATE TABLE klines (
    coin TEXT NOT NULL,
    tf TEXT NOT NULL,
    t INTEGER NOT NULL,
    o REAL NOT NULL,
    h REAL NOT NULL,
    l REAL NOT NULL,
    c REAL NOT NULL,
    v REAL NOT NULL,
    PRIMARY KEY (coin, tf, t)
  ) WITHOUT ROWID;
  `,
  // 5: stop-loss calibration per coin/timeframe, and the traffic light's own track record
  `
  CREATE TABLE risk_calib (
    coin TEXT NOT NULL,
    tf TEXT NOT NULL,
    probe TEXT NOT NULL,
    noise TEXT NOT NULL,
    horizon INTEGER NOT NULL,
    samples INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (coin, tf)
  ) WITHOUT ROWID;
  CREATE TABLE scorecard_points (
    coin TEXT NOT NULL,
    tf TEXT NOT NULL,
    t INTEGER NOT NULL,
    light TEXT NOT NULL,
    score INTEGER NOT NULL,
    close_pct REAL NOT NULL,
    atr_pct REAL NOT NULL,
    PRIMARY KEY (coin, tf, t)
  ) WITHOUT ROWID;
  `,
  // 6: candles stored per data source, so one series never mixes exchanges. The old
  // klines table stays (emptied) so a release rolled back without its database still runs.
  `
  CREATE TABLE candles (
    coin TEXT NOT NULL,
    tf TEXT NOT NULL,
    source TEXT NOT NULL,
    t INTEGER NOT NULL,
    o REAL NOT NULL,
    h REAL NOT NULL,
    l REAL NOT NULL,
    c REAL NOT NULL,
    v REAL NOT NULL,
    PRIMARY KEY (coin, tf, source, t)
  ) WITHOUT ROWID;
  INSERT INTO candles SELECT coin, tf, 'binance-spot', t, o, h, l, c, v FROM klines;
  DELETE FROM klines;
  `,
  // 7: perpetual-contract data: funding rate history and hourly open interest
  `
  CREATE TABLE funding_rates (
    coin TEXT NOT NULL,
    source TEXT NOT NULL,
    t INTEGER NOT NULL,
    rate REAL NOT NULL,
    mark_price REAL,
    PRIMARY KEY (coin, source, t)
  ) WITHOUT ROWID;
  CREATE TABLE open_interest (
    coin TEXT NOT NULL,
    source TEXT NOT NULL,
    t INTEGER NOT NULL,
    oi REAL NOT NULL,
    oi_value REAL,
    PRIMARY KEY (coin, source, t)
  ) WITHOUT ROWID;
  `,
  // 8: anonymous product events: a random visitor ID kept in the browser, the event name, the page, the time; no IP
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    vid TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE INDEX events_name_ts ON events(name, ts);
  CREATE INDEX events_vid_ts ON events(vid, ts);
  `,
  // 9: research reports (the whole report as JSON; the admin page and future pages read from here)
  `
  CREATE TABLE research_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    params_version INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX research_reports_kind ON research_reports(kind, id);
  `,
  // 10: taker buy volume per bar (Binance reports it; OKX does not, so it stays empty there).
  // A nullable column: an older release rolled back onto this database keeps working.
  `
  ALTER TABLE candles ADD COLUMN tbv REAL;
  `,
  // 11: the coins shown on the site (admin can add or hide one); filled with the built-in ten on first read.
  // An older release rolled back onto this database ignores it and shows its own list.
  `
  CREATE TABLE coins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    intro TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    listed_at INTEGER
  );
  `,
  // 12: daily spot valuation inputs for the long-term accumulation page: price, supply and MVRV from
  // Coin Metrics, the crypto-wide Fear & Greed index from alternative.me (stored on the BTC rows); day is UTC
  `
  CREATE TABLE spot_daily (
    asset TEXT NOT NULL,
    day TEXT NOT NULL,
    price REAL,
    supply REAL,
    mvrv REAL,
    fng INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (asset, day)
  ) WITHOUT ROWID;
  `,
];

let db: Database.Database | null = null;

/** Apply pending migrations (up to `target`, for tests of an upgrade from an older schema). */
export function migrate(d: Database.Database, target = MIGRATIONS.length) {
  const current = d.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < target; v++) {
    d.transaction(() => {
      d.exec(MIGRATIONS[v]);
      d.pragma(`user_version = ${v + 1}`);
    })();
  }
  return { from: current, to: Math.max(current, target) };
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
