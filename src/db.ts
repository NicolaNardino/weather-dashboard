import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { addDays, dayCount, eachDay, isoDay, ymd } from './dates';
import type { NormalRow } from './normals';

// WEATHER_DB lets the tests point the app at a throwaway database.
const DB_PATH = process.env.WEATHER_DB ?? path.join(process.cwd(), 'weather.db');

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

function getDb(): DatabaseSync {
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
    // Long-term daily normals per location, keyed by calendar day (MM-DD).
    // Computed once from a 30-year archive download (see normals.ts), so the
    // Compare view's reference line costs one fetch ever, not one per view.
    _db.exec(`
      CREATE TABLE IF NOT EXISTS public_normals (
        location TEXT NOT NULL,
        md       TEXT NOT NULL,
        ${PUBLIC_FIELDS.map(f => `${f} REAL`).join(', ')},
        PRIMARY KEY (location, md)
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

/** An inclusive window of calendar days, as stored `YYYY-MM-DD` keys. */
export interface Window { from: string; to: string }

export const dayWindow = (date: string): Window => ({ from: date, to: date });

export function monthWindow(year: number, month: number): Window {
  // Day 0 of the next month is this month's last day.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: ymd(year, month, 1), to: ymd(year, month, last) };
}

export const yearWindow = (year: number): Window =>
  ({ from: ymd(year, 1, 1), to: ymd(year, 12, 31) });

export function weekWindow(year: number, week: number): Window {
  // ISO week: walk back from Jan 4 (always in week 1) to that week's Monday.
  // Built in UTC to match `isoDay`, which reads the date back out that way.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = addDays(jan4, -((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  return { from: isoDay(monday), to: isoDay(addDays(monday, 6)) };
}

/** The rows inside a window — every period query is one of these. */
export const queryWindow = (w: Window): WeatherRow[] => queryRange(w.from, w.to);

/** One day as a row list — the row-list shape every other period query returns. */
export const queryDayRows = (date: string): WeatherRow[] => queryWindow(dayWindow(date));

export const queryMonth = (year: number, month: number): WeatherRow[] =>
  queryWindow(monthWindow(year, month));

export const queryYear = (year: number): WeatherRow[] => queryWindow(yearWindow(year));

export const queryWeek = (year: number, week: number): WeatherRow[] =>
  queryWindow(weekWindow(year, week));

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

export function queryNormals(location: string): NormalRow[] {
  return all<NormalRow>(
    `SELECT md, ${PUBLIC_FIELDS.join(', ')} FROM public_normals WHERE location = ? ORDER BY md`,
    location,
  );
}

export function upsertNormals(location: string, rows: NormalRow[]): void {
  const stmt = upsertStmt('public_normals', ['location', 'md', ...PUBLIC_FIELDS]);
  for (const r of rows) stmt.run(location, r.md, ...PUBLIC_FIELDS.map(f => r[f]));
}

/**
 * Round to `dp` decimal places. The one arithmetic rule the three places that
 * report a number share — the stat-card averages here, the running rain totals
 * below, and the long-term normals in normals.ts — and each spelled out its own
 * `Math.round(v * 100) / 100`.
 */
export const round = (v: number, dp = 2): number => Math.round(v * 10 ** dp) / 10 ** dp;

export function aggregateStats(rows: WeatherRow[]) {
  if (!rows.length) return null;

  // A measure to aggregate: reads one number out of a row. (Named `Get` rather
  // than `Field` so it doesn't shadow the exported column-name union.)
  type Get = (r: WeatherRow) => number;
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
      max:   max(r => r.precip),
    },
    rain: rainDays(rows),
    climate: climateDays(rows),
    spells: {
      wet: longestSpell(rows, isRainy),
      dry: longestSpell(rows, r => !isRainy(r)),
    },
  };
}

/** A rain day: any precipitation recorded. Rain days and wet/dry spells agree on it. */
const isRainy = (r: WeatherRow): boolean => r.precip > 0;

/**
 * Rain days over a set of rows: a day counts as rainy when any precipitation
 * was recorded. `pct` is their share of the days that have data (not of the
 * calendar days in the period), so a gap in the record doesn't read as dry.
 */
export function rainDays(rows: WeatherRow[]) {
  const days = rows.filter(isRainy).length;
  return {
    days,
    dry: rows.length - days,
    pct: rows.length ? Math.round((days / rows.length) * 100) : 0,
  };
}

/**
 * The MeteoSwiss climate-day counts: frost days (low below 0 °C), ice days
 * (high below 0 °C — every ice day is also a frost day), summer days (high of
 * 25 °C or more) and hot days (high of 30 °C or more — also summer days).
 */
export function climateDays(rows: WeatherRow[]) {
  const count = (test: (r: WeatherRow) => boolean) => rows.filter(test).length;
  return {
    frost:  count(r => r.temp_low < 0),
    ice:    count(r => r.temp_high < 0),
    summer: count(r => r.temp_high >= 25),
    hot:    count(r => r.temp_high >= 30),
  };
}

/** A run of consecutive days; `from`/`to` are null when no day qualified. */
export interface Spell { days: number; from: string | null; to: string | null }

/**
 * The longest run of consecutive calendar days that all pass `test`, earliest
 * first on a tie. A day missing from the record ends the run rather than being
 * assumed either way. `rows` must be in date order, as every query returns them.
 */
export function longestSpell(rows: WeatherRow[], test: (r: WeatherRow) => boolean): Spell {
  let best: Spell = { days: 0, from: null, to: null };
  let start = '';
  let len = 0;
  let prev = '';
  for (const r of rows) {
    if (!test(r)) { len = 0; prev = r.date; continue; }
    if (len && dayCount(prev, r.date) === 2) len++;
    else { len = 1; start = r.date; }
    prev = r.date;
    if (len > best.days) best = { days: len, from: start, to: r.date };
  }
  return best;
}

/**
 * Running precipitation total through each year, one point per recorded day:
 * the year-to-date rain curve. A year whose record starts mid-year accumulates
 * from its first recorded day.
 */
export function precipYtd(): { year: number; days: { md: string; total: number }[] }[] {
  return queryYears().map(year => {
    let total = 0;
    const days = queryYear(year).map(r => {
      total += r.precip;
      return { md: r.date.slice(5), total: round(total) };
    });
    return { year, days };
  });
}

/**
 * How completely a window is recorded: the days it should hold, the days it
 * does, and the dates it is missing.
 *
 * The window is first clipped to the span the station has records for at all
 * (first to latest stored date), so days before the station started, and days
 * that haven't happened or been imported yet, don't count as missing — a Year
 * view in September isn't "missing" October to December.
 */
export function coverage(w: Window, rows: WeatherRow[]) {
  const bounds = one<{ first: string | null; last: string | null }>(
    'SELECT MIN(date) AS first, MAX(date) AS last FROM weather',
  );
  const from = bounds?.first && bounds.first > w.from ? bounds.first : w.from;
  const to = bounds?.last && bounds.last < w.to ? bounds.last : w.to;
  const have = new Set(rows.map(r => r.date));
  const days = bounds?.first ? eachDay(from, to) : [];
  const missing = days.filter(d => !have.has(d));
  const expected = days.length;
  return { expected, recorded: expected - missing.length, missing };
}
