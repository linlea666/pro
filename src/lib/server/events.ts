import { EVENT_NAMES, type EventName } from "../event-names.ts";
import { getDb } from "./db.ts";

/**
 * Minimal anonymous product events: a random visitor ID the browser keeps,
 * the event name, the page and the time. No IP and nothing personal; kept
 * in our own database for a little over a year.
 */

const DAY = 24 * 3600 * 1000;
export const EVENT_KEEP_DAYS = 400;

export function isEventName(x: unknown): x is EventName {
  return typeof x === "string" && Object.hasOwn(EVENT_NAMES, x);
}

export function recordEvent(vid: string, name: EventName, path: string, ts = Date.now()) {
  getDb().prepare("INSERT INTO events (ts, vid, name, path) VALUES (?, ?, ?, ?)").run(ts, vid, name, path);
}

export function pruneEvents(now = Date.now()): number {
  return getDb().prepare("DELETE FROM events WHERE ts < ?").run(now - EVENT_KEEP_DAYS * DAY).changes;
}

const distinct = (from: number, to: number, name?: EventName) =>
  (
    (name
      ? getDb().prepare("SELECT COUNT(DISTINCT vid) n FROM events WHERE name = ? AND ts >= ? AND ts < ?").get(name, from, to)
      : getDb().prepare("SELECT COUNT(DISTINCT vid) n FROM events WHERE ts >= ? AND ts < ?").get(from, to)) as { n: number }
  ).n;

export interface RetentionRow {
  day: number;
  /** visitors whose first visit is at least `day` days old (and at most 90) */
  cohort: number;
  returned: number;
  rate: number | null;
}

/** Share of new visitors who came back on day 1 / 7 / 30 after their first visit (24-hour windows). */
export function retention(now = Date.now()): RetentionRow[] {
  return [1, 7, 30].map((day) => {
    const r = getDb()
      .prepare(
        `SELECT COUNT(*) cohort, SUM(back) returned FROM (
           SELECT f.vid, EXISTS (SELECT 1 FROM events e WHERE e.vid = f.vid AND e.ts >= f.ts + ? AND e.ts < f.ts + ?) back
           FROM (SELECT vid, MIN(ts) ts FROM events WHERE name = 'first_visit' GROUP BY vid) f
           WHERE f.ts <= ? AND f.ts > ?
         )`,
      )
      .get(day * DAY, (day + 1) * DAY, now - (day + 1) * DAY, now - 90 * DAY) as { cohort: number; returned: number | null };
    const returned = r.returned ?? 0;
    return { day, cohort: r.cohort, returned, rate: r.cohort ? Math.round((returned / r.cohort) * 1000) / 10 : null };
  });
}

export interface WeekRow {
  /** start of the 7-day window, ms */
  from: number;
  active: number;
  newVisitors: number;
  /** distinct visitors per event over the window */
  features: Partial<Record<EventName, number>>;
}

/** The last `weeks` 7-day windows, newest first. */
export function weekly(weeks = 8, now = Date.now()): WeekRow[] {
  const out: WeekRow[] = [];
  for (let k = 0; k < weeks; k++) {
    const to = now - k * 7 * DAY;
    const from = to - 7 * DAY;
    const features: Partial<Record<EventName, number>> = {};
    for (const name of Object.keys(EVENT_NAMES) as EventName[]) {
      if (name === "visit" || name === "first_visit") continue;
      features[name] = distinct(from, to, name);
    }
    out.push({ from, active: distinct(from, to), newVisitors: distinct(from, to, "first_visit"), features });
  }
  return out;
}

export function productMetrics(now = Date.now()) {
  const total = (getDb().prepare("SELECT COUNT(*) n, MIN(ts) first FROM events").get() as { n: number; first: number | null });
  return {
    events: total.n,
    since: total.first,
    dau: distinct(now - DAY, now),
    wau: distinct(now - 7 * DAY, now),
    mau: distinct(now - 30 * DAY, now),
    weeks: weekly(8, now),
    retention: retention(now),
  };
}
