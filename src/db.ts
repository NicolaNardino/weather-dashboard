import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { addDays, isoDay, ymd } from './dates';

const DB_PATH = path.join(process.cwd(), 'weather.db');

/**
 * The 15 measure columns, in the order they appear in weather_data.txt after
 * the date. This is the single source of truth for them: it builds the
 * `weather` table, types `WeatherRow`, and drives the import (see import.ts) —
 * so a new column is added here alone rather than in three lists that had to
 * agree.
 */
export const FIELDS = [
  'temp_high', 'temp_avg', 'temp_low',
  'dew_high', 'dew_avg', 'dew_low',
  'hum_high', 'hum_avg', 'hum_low',
  'wind_high', 'wind_avg', 'wind_low',
  'pres_high', 'pres_low', 'precip',
] as const;

export type Field = (typeof FIELDS)[number];

/** Every column of the `weather` table, in insert order. */
export const COLUMNS = ['date', ...FIELDS];

/**
 * The measures the public weather service supplies — the subset of FIELDS the
 * Compare view can line my data up against. Like FIELDS, this is the single
 * source of truth: it builds the `public_weather` cache table, types
 * `PublicRow`, and drives both its SELECT and its INSERT.
 */
export const PUBLIC_FIELDS = ['temp_high', 'temp_low', 'wind_high', 'precip'] as const;

export type PublicField = (typeof PUBLIC_FIELDS)[number];

/** A cached public-service day: the date, and one nullable number per field. */
export type PublicRow = { date: string } & Record<PublicField, number | null>;

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    _db.exec(`PRAGMA journal_mode=WAL`);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS weather (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        ${FIELDS.map(f => `${f} REAL`).join(', ')}
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    // Local cache of daily data fetched from the public weather service
    // (Open-Meteo), keyed per location + date so the Compare view can be
    // served without re-hitting the network (and works offline).
    _db.exec(`
      CREATE TABLE IF NOT EXISTS public_weather (
        location   TEXT NOT NULL,
        date       TEXT NOT NULL,
        ${PUBLIC_FIELDS.map(f => `${f} REAL`).join(', ')},
        fetched_at TEXT,
        PRIMARY KEY (location, date)
      )
    `);
  }
  return _db;
}

// node:sqlite types rows as its own record shape, so every read needs the same
// double cast; these two wrappers keep it in one place.
type Param = string | number;
const all = <T>(sql: string, ...params: Param[]): T[] =>
  getDb().prepare(sql).all(...params) as unknown as T[];
const one = <T>(sql: string, ...params: Param[]): T | undefined =>
  getDb().prepare(sql).get(...params) as unknown as T | undefined;

/**
 * An `INSERT OR REPLACE` over the named columns — the only write shape this app
 * has. Every table is keyed on its natural key (date, or location+date), so
 * re-running an import or a fetch replaces rather than duplicates. The three
 * writers each built this SQL themselves, spelling out the same `join(', ')` /
 * one-`?`-per-column pair.
 */
export function upsertStmt(table: string, columns: readonly string[]) {
  return getDb().prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(',')})`,
  );
}

// Small key/value store for app metadata (e.g. last import timestamp).
export function setMeta(key: string, value: string): void {
  upsertStmt('meta', ['key', 'value']).run(key, value);
}

export function getMeta(key: string): string | undefined {
  return one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
}

/** A row of the `weather` table: the id, the date, and one number per FIELD. */
export type WeatherRow = { id: number; date: string } & Record<Field, number>;

export function queryRange(from: string, to: string): WeatherRow[] {
  return all<WeatherRow>(
    'SELECT * FROM weather WHERE date >= ? AND date <= ? ORDER BY date', from, to,
  );
}

/** One day as a row list — the row-list shape every other period query returns. */
export const queryDayRows = (date: string): WeatherRow[] => queryRange(date, date);

/** One calendar month. Day 31 is a safe upper bound — the dates are compared as
    strings, so a shorter month simply has no rows past its own last day. */
export function queryMonth(year: number, month: number): WeatherRow[] {
  return queryRange(ymd(year, month, 1), ymd(year, month, 31));
}

export function queryYear(year: number): WeatherRow[] {
  return queryRange(ymd(year, 1, 1), ymd(year, 12, 31));
}

export function queryWeek(year: number, week: number): WeatherRow[] {
  // ISO week: walk back from Jan 4 (always in week 1) to that week's Monday.
  // Built in UTC to match `isoDay`, which reads the date back out that way.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = addDays(jan4, -((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  return queryRange(isoDay(monday), isoDay(addDays(monday, 6)));
}

/** Every stored row. Only the import needs this — it diffs against what's there. */
export function queryAllRows(): WeatherRow[] {
  return all<WeatherRow>('SELECT * FROM weather');
}

/** Every stored date, ascending — the pool the front-end's pickers draw from. */
export function queryAllDates(): string[] {
  return all<{ date: string }>('SELECT date FROM weather ORDER BY date').map(r => r.date);
}

/** Distinct calendar years present in the data, ascending — drives the
    year-over-year comparison, which gathers the same period across each. */
export function queryYears(): number[] {
  return all<{ y: string }>(
    'SELECT DISTINCT substr(date, 1, 4) AS y FROM weather ORDER BY y',
  ).map(r => Number(r.y));
}

// --- Public weather service cache (Open-Meteo) ---

export function queryPublicRange(location: string, from: string, to: string): PublicRow[] {
  return all<PublicRow>(
    `SELECT date, ${PUBLIC_FIELDS.join(', ')}
       FROM public_weather
      WHERE location = ? AND date >= ? AND date <= ?
      ORDER BY date`,
    location, from, to,
  );
}

export function upsertPublic(location: string, rows: PublicRow[]): void {
  const stmt = upsertStmt('public_weather', ['location', 'date', ...PUBLIC_FIELDS, 'fetched_at']);
  const now = new Date().toISOString();
  for (const r of rows) {
    stmt.run(location, r.date, ...PUBLIC_FIELDS.map(f => r[f]), now);
  }
}

export function aggregateStats(rows: WeatherRow[]) {
  if (!rows.length) return null;

  // A measure to aggregate: reads one number out of a row. (Named `Get` rather
  // than `Field` so it doesn't shadow the exported column-name union.)
  type Get = (r: WeatherRow) => number;
  const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
  const max = (f: Get) => Math.max(...rows.map(f));
  const min = (f: Get) => Math.min(...rows.map(f));
  const sum = (f: Get) => rows.reduce((a, r) => a + f(r), 0);
  const avg = (f: Get, dp = 1) => round(sum(f) / rows.length, dp);

  // Every <prefix>_high/_low pair aggregates the same way — the period's
  // extremes around a mean. Only the mean differs: three measures average their
  // stored daily average, while pressure has none and takes each day's mid-point
  // instead, which used to mean spelling that whole group out a second time.
  const triple = (p: 'temp' | 'hum' | 'dew' | 'pres', mean: Get, dp = 1) => ({
    high: max(r => r[`${p}_high`]),
    avg:  avg(mean, dp),
    low:  min(r => r[`${p}_low`]),
  });

  return {
    count: rows.length,
    temp: triple('temp', r => r.temp_avg),
    humidity: triple('hum', r => r.hum_avg),
    wind: {
      high: max(r => r.wind_high),
      avg:  avg(r => r.wind_avg),
    },
    pressure: triple('pres', r => (r.pres_high + r.pres_low) / 2, 2),
    dew: triple('dew', r => r.dew_avg),
    precip: {
      total: round(sum(r => r.precip), 2),
      rainy_days: rows.filter(r => r.precip > 0).length,
    },
  };
}
