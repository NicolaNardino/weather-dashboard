import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { addDays, eachDay, isoDay, mdOf, nextDay, ymd } from './dates';
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

/** The column a row of public readings is keyed by — a day, or a calendar day. */
export type FieldKey = 'date' | 'md';

/**
 * A row of one reading per public field, under the key that identifies it — a
 * `date` for a fetched or cached day (`PublicRow` below), an `md` for a
 * long-term normal (`NormalRow` in normals.ts). Those two differ only in that
 * key, so this says the body once and they name the key.
 *
 * The shape was written out five times for those three names: as `PublicRow`,
 * twice inside `fieldRow` below (its return annotation and the cast behind it,
 * since `Object.fromEntries` types its result as a plain `Record<string, …>`
 * however it is written), as the `CachedRow` the caches store and read back,
 * and once more as `NormalRow`. Each asserted again which fields make up a
 * row, which is the very thing PUBLIC_FIELDS above is the source of truth for.
 */
export type FieldRow<K extends FieldKey> = Record<K, string> &
  Record<PublicField, number | null>;

/** A cached public-service day: the date, and one nullable number per field. */
export type PublicRow = FieldRow<'date'>;

/**
 * Build one: the key's value, then one reading per public field.
 *
 * Four places built the body themselves, in three spellings: the two in
 * `server.ts` shared a `publicRow` helper that spelled out the
 * `Object.fromEntries` over PUBLIC_FIELDS with a cast behind it, `normals.ts`
 * cast an empty object to the row type and filled it field by field, and the
 * route test built one more with `as any` — so a new public measure reached
 * some of them and not others.
 */
export const fieldRow = <K extends FieldKey>(
  key: K,
  id: string,
  read: (field: PublicField) => number | null,
): FieldRow<K> =>
  ({
    [key]: id,
    ...Object.fromEntries(PUBLIC_FIELDS.map(f => [f, read(f)])),
  }) as FieldRow<K>;

/** One cache's spec, as the two helpers further down take it. */
type Cache<K extends FieldKey> = { table: string; key: K; stamped: boolean };

/**
 * The two per-location caches of public-service readings (Open-Meteo): the days
 * fetched for the Compare view, and the long-term daily normals it sets them
 * against — the latter computed once from a 30-year archive download (see
 * normals.ts), so the reference line costs one fetch ever rather than one per
 * view. Both are served without re-hitting the network, so the view works
 * offline.
 *
 * They are the same table in all but the column they key a location's rows by
 * and the fetch stamp only the fetched days carry, yet the table, its SELECT
 * and its upsert were each spelled out twice over — six near-identical
 * statements that a new public measure had to reach all of. `fieldRow` above
 * already names a row's body once; this names the table holding it once.
 */
const PUBLIC_CACHE = {
  /** Fetched daily rows, keyed by `YYYY-MM-DD` and stamped with the fetch time. */
  weather: { table: 'public_weather', key: 'date', stamped: true },
  /** Long-term normals, keyed by calendar day (`MM-DD`); nothing to date. */
  normals: { table: 'public_normals', key: 'md', stamped: false },
} as const satisfies Record<string, Cache<FieldKey>>;

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
    // Both public-service caches (see PUBLIC_CACHE): location + its key column,
    // one column per measure, and the fetch stamp where the cache carries one.
    for (const c of Object.values(PUBLIC_CACHE)) {
      _db.exec(`CREATE TABLE IF NOT EXISTS ${c.table} (${[
        'location TEXT NOT NULL',
        `${c.key} TEXT NOT NULL`,
        ...PUBLIC_FIELDS.map(f => `${f} REAL`),
        ...(c.stamped ? ['fetched_at TEXT'] : []),
        `PRIMARY KEY (location, ${c.key})`,
      ].join(', ')})`);
    }
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
 *
 * Values bind by **name** (`@column`), so a caller hands over the row as an
 * object. Positionally, every write stated its columns twice — once in the
 * column list, once as the run of `?` after it — and then relied on a third
 * list, the arguments, arriving in that same order, which nothing checks. Two
 * of the three writers were bending to keep that order: the import carried its
 * fifteen measures as an array parallel to FIELDS and read them back by index,
 * and the cache writer appended its fetch stamp as `...stamp.map(() => now)`,
 * an empty-or-one-element spread standing in for "iff this table carries one".
 */
export function upsertStmt(table: string, columns: readonly string[]) {
  return getDb().prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map(c => `@${c}`).join(', ')})`,
  );
}

// Small key/value store for app metadata (e.g. last import timestamp).
export function setMeta(key: string, value: string): void {
  upsertStmt('meta', ['key', 'value']).run({ key, value });
}

export function getMeta(key: string): string | undefined {
  return one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
}

/** A row of the `weather` table: the id, the date, and one number per FIELD. */
export type WeatherRow = { id: number; date: string } & Record<Field, number>;

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

/**
 * The rows inside a window, in date order — every read of stored readings is
 * one of these. It was two: a `queryRange(from, to)` and a `queryWindow(w)`
 * wrapping it, so the one SELECT this app makes had two exported names and the
 * Compare route reached for the pair of days rather than naming the window it
 * was already being asked about.
 */
export const queryWindow = (w: Window): WeatherRow[] =>
  all<WeatherRow>(
    'SELECT * FROM weather WHERE date >= ? AND date <= ? ORDER BY date', w.from, w.to,
  );

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

/**
 * A location's cached rows, in key order — narrowed to an inclusive key range
 * where one is given, which is the only way the two readers differ: the fetch
 * cache is read for the window being compared, the normals whole.
 */
const cacheRows = <K extends FieldKey>(
  c: Cache<K>, location: string, range?: Window,
): FieldRow<K>[] =>
  all<FieldRow<K>>(
    `SELECT ${c.key}, ${PUBLIC_FIELDS.join(', ')}
       FROM ${c.table}
      WHERE location = ?${range ? ` AND ${c.key} >= ? AND ${c.key} <= ?` : ''}
      ORDER BY ${c.key}`,
    ...(range ? [location, range.from, range.to] : [location]),
  );

/** Store a location's rows, replacing any it already holds for the same keys. */
const writeCache = <K extends FieldKey>(
  c: Cache<K>, location: string, rows: readonly FieldRow<K>[],
): void => {
  // The fetch stamp only the fetched-days cache carries, named once: it is both
  // a column of that table and a field of every row written to it.
  const stamp = c.stamped ? { fetched_at: new Date().toISOString() } : {};
  const stmt = upsertStmt(c.table, ['location', c.key, ...PUBLIC_FIELDS, ...Object.keys(stamp)]);
  // A cached row is exactly its key column plus one per public field, so it is
  // the written row already — only the location and the stamp are added.
  for (const r of rows) stmt.run({ location, ...r, ...stamp });
};

export const queryPublicRange = (location: string, from: string, to: string): PublicRow[] =>
  cacheRows(PUBLIC_CACHE.weather, location, { from, to });

export const upsertPublic = (location: string, rows: PublicRow[]): void =>
  writeCache(PUBLIC_CACHE.weather, location, rows);

export const queryNormals = (location: string): NormalRow[] =>
  cacheRows(PUBLIC_CACHE.normals, location);

export const upsertNormals = (location: string, rows: NormalRow[]): void =>
  writeCache(PUBLIC_CACHE.normals, location, rows);

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

  // No day count here: every reader of these stats already holds the rows they
  // were computed from — the dashboard has `data.rows`, and the across-years
  // view reports `days.recorded` off the very same list — so `count` was a
  // second copy of `rows.length` travelling over the wire, read by nobody.
  return {
    temp: triple('temp', r => r.temp_avg),
    humidity: triple('hum', r => r.hum_avg),
    wind: {
      high: max(r => r.wind_high),
      avg:  avg(r => r.wind_avg),
    },
    pressure: triple('pres', r => (r.pres_high + r.pres_low) / 2, 2),
    dew: triple('dew', r => r.dew_avg),
    precip: {
      total: round(sum(r => r.precip)),
      max:   max(r => r.precip),
    },
    rain: rainDays(rows),
    climate: climateDays(rows),
    spells: {
      wet: longestSpell(rows, DAY_IS.rainy),
      dry: longestSpell(rows, r => !DAY_IS.rainy(r)),
      hot: longestSpell(rows, DAY_IS.hot),
    },
  };
}

/** Something a day either is or isn't — one of the kinds below, or a negation. */
type DayTest = (r: WeatherRow) => boolean;

/**
 * What makes a day one of the kinds this app counts: that it rained at all, and
 * the four MeteoSwiss climate days — frost (low below 0 °C), ice (high below
 * 0 °C, so every ice day is also a frost day), summer (high of 25 °C or more)
 * and hot (30 °C or more, so also a summer day).
 *
 * Three readings ask the same questions — the climate-day counts, the rain-day
 * share, and the longest run of consecutive such days — and only the two kinds
 * a spell is measured over were named. The other three thresholds sat inside
 * the one function that counted them, so where a definition lived depended on
 * how many readings happened to want it.
 */
const DAY_IS = {
  rainy: (r: WeatherRow) => r.precip > 0,
  frost: (r: WeatherRow) => r.temp_low < 0,
  ice: (r: WeatherRow) => r.temp_high < 0,
  summer: (r: WeatherRow) => r.temp_high >= 25,
  hot: (r: WeatherRow) => r.temp_high >= 30,
} satisfies Record<string, DayTest>;

/** How many of `rows` pass `test` — what both day-count readings below total. */
const countDays = (rows: WeatherRow[], test: DayTest): number => rows.filter(test).length;

/**
 * Rain days over a set of rows. `pct` is their share of the days that have data
 * (not of the calendar days in the period), so a gap in the record doesn't read
 * as dry.
 */
export function rainDays(rows: WeatherRow[]) {
  const days = countDays(rows, DAY_IS.rainy);
  return {
    days,
    dry: rows.length - days,
    pct: rows.length ? Math.round((days / rows.length) * 100) : 0,
  };
}

/** The MeteoSwiss climate-day counts (see DAY_IS for the thresholds). */
export function climateDays(rows: WeatherRow[]) {
  return {
    frost:  countDays(rows, DAY_IS.frost),
    ice:    countDays(rows, DAY_IS.ice),
    summer: countDays(rows, DAY_IS.summer),
    hot:    countDays(rows, DAY_IS.hot),
  };
}

/** A run of consecutive days; `from`/`to` are null when no day qualified. */
export interface Spell { days: number; from: string | null; to: string | null }

/**
 * The longest run of consecutive calendar days that all pass `test`, earliest
 * first on a tie. A day missing from the record ends the run rather than being
 * assumed either way. `rows` must be in date order, as every query returns them.
 */
export function longestSpell(rows: WeatherRow[], test: DayTest): Spell {
  let best: Spell = { days: 0, from: null, to: null };
  let start = '';
  let len = 0;
  let prev = '';
  for (const r of rows) {
    // Three ways a day lands: it doesn't qualify and ends the run, it qualifies
    // and follows the open run's last day, or it qualifies and opens a new run.
    // The first used to `continue` out of the loop so that it could record `prev`
    // on the way — which meant that one assignment written twice, and a branch
    // whose only job was to skip a `best` update that a zero-length run can't
    // win anyway.
    if (!test(r)) len = 0;
    else if (len && nextDay(prev) === r.date) len++;
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
    const days = queryWindow(yearWindow(year)).map(r => {
      total += r.precip;
      return { md: mdOf(r.date), total: round(total) };
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
  // Nothing recorded at all: no day is expected, so none can be missing. Asked
  // once here, the two clamps below are plain comparisons — each used to repeat
  // the `bounds?.first` test to stand in for this, and the window was clipped
  // even when there was no span to clip it to.
  if (!bounds?.first || !bounds.last) return { expected: 0, recorded: 0, missing: [] };

  // Clipped to the recorded span. Stored dates compare as strings, so the later
  // of two starts and the earlier of two ends are plain `>`/`<`.
  const from = bounds.first > w.from ? bounds.first : w.from;
  const to = bounds.last < w.to ? bounds.last : w.to;
  const have = new Set(rows.map(r => r.date));
  const days = eachDay(from, to);
  const missing = days.filter(d => !have.has(d));
  return { expected: days.length, recorded: days.length - missing.length, missing };
}
