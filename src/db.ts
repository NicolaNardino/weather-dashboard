import { DatabaseSync } from 'node:sqlite';
import path from 'path';

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
        temp_high  REAL, temp_low REAL, wind_high REAL, precip REAL,
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

// Small key/value store for app metadata (e.g. last import timestamp).
export function setMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getMeta(key: string): string | undefined {
  return one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
}

/** A row of the `weather` table: the id, the date, and one number per FIELD. */
export type WeatherRow = { id: number; date: string } & Record<Field, number>;

export function queryDay(date: string): WeatherRow | undefined {
  return one<WeatherRow>('SELECT * FROM weather WHERE date = ?', date);
}

export function queryRange(from: string, to: string): WeatherRow[] {
  return all<WeatherRow>(
    'SELECT * FROM weather WHERE date >= ? AND date <= ? ORDER BY date', from, to,
  );
}

export function queryMonth(year: number, month: number): WeatherRow[] {
  const m = String(month).padStart(2, '0');
  const from = `${year}-${m}-01`;
  const to   = `${year}-${m}-31`;
  return queryRange(from, to);
}

export function queryYear(year: number): WeatherRow[] {
  return queryRange(`${year}-01-01`, `${year}-12-31`);
}

export function queryWeek(year: number, week: number): WeatherRow[] {
  // ISO week: walk back from Jan 4 (always in week 1) to that week's Monday.
  // All UTC: the dates are formatted with toISOString, so building them in
  // local time shifted them a day either side of midnight west/east of UTC.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const isoDate = (d: Date) => d.toISOString().slice(0, 10);
  return queryRange(isoDate(monday), isoDate(sunday));
}

export function queryAllDates(): { date: string }[] {
  return all<{ date: string }>('SELECT date FROM weather ORDER BY date');
}

/** Distinct calendar years present in the data, ascending — drives the
    year-over-year comparison, which gathers the same period across each. */
export function queryYears(): number[] {
  return all<{ y: string }>(
    'SELECT DISTINCT substr(date, 1, 4) AS y FROM weather ORDER BY y',
  ).map(r => Number(r.y));
}

// --- Public weather service cache (Open-Meteo) ---

export interface PublicRow {
  date: string;
  temp_high: number | null;
  temp_low: number | null;
  wind_high: number | null;
  precip: number | null;
}

export function queryPublicRange(location: string, from: string, to: string): PublicRow[] {
  return all<PublicRow>(
    `SELECT date, temp_high, temp_low, wind_high, precip
       FROM public_weather
      WHERE location = ? AND date >= ? AND date <= ?
      ORDER BY date`,
    location, from, to,
  );
}

export function upsertPublic(location: string, rows: PublicRow[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO public_weather
       (location, date, temp_high, temp_low, wind_high, precip, fetched_at)
     VALUES (?,?,?,?,?,?,?)`
  );
  const now = new Date().toISOString();
  for (const r of rows) {
    stmt.run(location, r.date, r.temp_high, r.temp_low, r.wind_high, r.precip, now);
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

  return {
    count: rows.length,
    temp: {
      high: max(r => r.temp_high),
      avg:  avg(r => r.temp_avg),
      low:  min(r => r.temp_low),
    },
    humidity: {
      high: max(r => r.hum_high),
      avg:  avg(r => r.hum_avg),
      low:  min(r => r.hum_low),
    },
    wind: {
      high: max(r => r.wind_high),
      avg:  avg(r => r.wind_avg),
    },
    pressure: {
      high: max(r => r.pres_high),
      // Mid-point of each day's high/low, averaged over the period.
      avg:  avg(r => (r.pres_high + r.pres_low) / 2, 2),
      low:  min(r => r.pres_low),
    },
    dew: {
      high: max(r => r.dew_high),
      avg:  avg(r => r.dew_avg),
      low:  min(r => r.dew_low),
    },
    precip: {
      total: round(sum(r => r.precip), 2),
      max:   max(r => r.precip),
      rainy_days: rows.filter(r => r.precip > 0).length,
    },
  };
}
