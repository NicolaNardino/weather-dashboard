import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'weather.db');

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    _db.exec(`PRAGMA journal_mode=WAL`);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS weather (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT UNIQUE NOT NULL,
        temp_high   REAL, temp_avg REAL, temp_low REAL,
        dew_high    REAL, dew_avg  REAL, dew_low  REAL,
        hum_high    REAL, hum_avg  REAL, hum_low  REAL,
        wind_high   REAL, wind_avg REAL, wind_low REAL,
        pres_high   REAL, pres_low REAL,
        precip      REAL
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

// Small key/value store for app metadata (e.g. last import timestamp).
export function setMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getMeta(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export interface WeatherRow {
  id: number;
  date: string;
  temp_high: number; temp_avg: number; temp_low: number;
  dew_high: number;  dew_avg: number;  dew_low: number;
  hum_high: number;  hum_avg: number;  hum_low: number;
  wind_high: number; wind_avg: number; wind_low: number;
  pres_high: number; pres_low: number;
  precip: number;
}

export function queryDay(date: string): WeatherRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM weather WHERE date = ?').get(date) as unknown as WeatherRow | undefined;
}

export function queryRange(from: string, to: string): WeatherRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM weather WHERE date >= ? AND date <= ? ORDER BY date'
  ).all(from, to) as unknown as WeatherRow[];
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
  // ISO week: find the Monday of that week
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - (dayOfWeek - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return queryRange(fmt(monday), fmt(sunday));
}

export function queryAllDates(): { date: string }[] {
  const db = getDb();
  return db.prepare('SELECT date FROM weather ORDER BY date').all() as unknown as { date: string }[];
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
  return getDb().prepare(
    `SELECT date, temp_high, temp_low, wind_high, precip
       FROM public_weather
      WHERE location = ? AND date >= ? AND date <= ?
      ORDER BY date`
  ).all(location, from, to) as unknown as PublicRow[];
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

/** The numeric measurement columns — everything on a row but its id and date. */
type Measure = Exclude<keyof WeatherRow, 'id' | 'date'>;

export function aggregateStats(rows: WeatherRow[]) {
  if (!rows.length) return null;

  const col = (key: Measure) => rows.map(r => r[key]);
  const max = (key: Measure) => Math.max(...col(key));
  const min = (key: Measure) => Math.min(...col(key));
  const sum = (vals: number[]) => vals.reduce((a, b) => a + b, 0);
  const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
  /** Mean of `vals`, rounded for display. */
  const mean = (vals: number[], dp = 1) => round(sum(vals) / vals.length, dp);
  const avg = (key: Measure, dp = 1) => mean(col(key), dp);

  return {
    count: rows.length,
    temp:     { high: max('temp_high'), avg: avg('temp_avg'), low: min('temp_low') },
    humidity: { high: max('hum_high'),  avg: avg('hum_avg'),  low: min('hum_low') },
    wind:     { high: max('wind_high'), avg: avg('wind_avg') },
    pressure: {
      high: max('pres_high'),
      // Each day's mid-point (high+low)/2, averaged over the period.
      avg: mean(rows.map(r => (r.pres_high + r.pres_low) / 2), 2),
      low: min('pres_low'),
    },
    dew:      { high: max('dew_high'),  avg: avg('dew_avg'),  low: min('dew_low') },
    precip: {
      total: round(sum(col('precip')), 2),
      max:   max('precip'),
      rainy_days: rows.filter(r => r.precip > 0).length,
    },
  };
}
