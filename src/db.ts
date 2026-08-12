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

// node:sqlite returns loosely-typed records; these two wrappers keep the
// prepare/cast boilerplate in one place so the queries below stay one-liners.
type Param = string | number | null;

function all<T>(sql: string, ...params: Param[]): T[] {
  return getDb().prepare(sql).all(...params) as unknown as T[];
}

function one<T>(sql: string, ...params: Param[]): T | undefined {
  return getDb().prepare(sql).get(...params) as unknown as T | undefined;
}

// Small key/value store for app metadata (e.g. last import timestamp).
export function setMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getMeta(key: string): string | undefined {
  return one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
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
  return one<WeatherRow>('SELECT * FROM weather WHERE date = ?', date);
}

export function queryRange(from: string, to: string): WeatherRow[] {
  return all<WeatherRow>(
    'SELECT * FROM weather WHERE date >= ? AND date <= ? ORDER BY date',
    from, to,
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
  return all<{ date: string }>('SELECT date FROM weather ORDER BY date');
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

  const sum = (pick: (r: WeatherRow) => number) => rows.reduce((a, r) => a + pick(r), 0);
  const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;
  const max = (pick: (r: WeatherRow) => number) => Math.max(...rows.map(pick));
  const min = (pick: (r: WeatherRow) => number) => Math.min(...rows.map(pick));
  const avg = (pick: (r: WeatherRow) => number, dp = 1) => round(sum(pick) / rows.length, dp);

  // high/avg/low triple over three columns of the same measure.
  const triple = (
    high: (r: WeatherRow) => number,
    mean: (r: WeatherRow) => number,
    low: (r: WeatherRow) => number,
    dp = 1,
  ) => ({ high: max(high), avg: avg(mean, dp), low: min(low) });

  return {
    count: rows.length,
    temp: triple(r => r.temp_high, r => r.temp_avg, r => r.temp_low),
    humidity: triple(r => r.hum_high, r => r.hum_avg, r => r.hum_low),
    wind: {
      high: max(r => r.wind_high),
      avg: avg(r => r.wind_avg),
    },
    // No stored pressure average — use the midpoint of each day's high/low.
    pressure: triple(r => r.pres_high, r => (r.pres_high + r.pres_low) / 2, r => r.pres_low, 2),
    dew: triple(r => r.dew_high, r => r.dew_avg, r => r.dew_low),
    precip: {
      total: round(sum(r => r.precip), 2),
      max: max(r => r.precip),
      rainy_days: rows.filter(r => r.precip > 0).length,
    },
  };
}
