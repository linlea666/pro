import { getDb } from "./db.ts";

/** Key/value settings with code defaults; the database only stores overrides. */
export const SETTING_DEFAULTS = {
  "log.retentionDays": 90,
  "log.maxDbMB": 2048,
  "log.weeklyArchive": false,
  "log.archiveKeepWeeks": 52,
  "backup.keepDaily": 7,
  "precompute.enabled": true,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
type Val<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K] extends boolean ? boolean : (typeof SETTING_DEFAULTS)[K] extends number ? number : string;

export function getSetting<K extends SettingKey>(key: K): Val<K> {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return (row ? JSON.parse(row.value) : SETTING_DEFAULTS[key]) as Val<K>;
}

export function setSetting<K extends SettingKey>(key: K, value: Val<K>) {
  getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(key, JSON.stringify(value), Date.now());
}

/** Internal bookkeeping values (job timestamps etc.), not user-facing settings. */
export function getState(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(`state.${key}`) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setState(key: string, value: string) {
  getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(`state.${key}`, value, Date.now());
}
