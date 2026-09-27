/**
 * Shared test setup. Import this FIRST in a test file: it points the app at a
 * throwaway SQLite file (see WEATHER_DB in db.ts) before `db.ts` opens one, so
 * no test ever touches the real weather.db. `node --test` runs each file in
 * its own process, so every file gets a database of its own.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-test-'));
process.env.WEATHER_DB = path.join(TMP_DIR, 'weather.db');

// Imported after the env var is set — CommonJS runs these in source order.
import { COLUMNS, FIELDS, upsertStmt, WeatherRow } from '../db';

/** A day's row with mild, dry defaults; `over` sets only what a test cares about. */
export function row(date: string, over: Partial<WeatherRow> = {}): WeatherRow {
  const base = Object.fromEntries(FIELDS.map(f => [f, 0])) as Record<(typeof FIELDS)[number], number>;
  return {
    id: 0, date, ...base,
    temp_high: 15, temp_avg: 10, temp_low: 5,
    hum_high: 80, hum_avg: 60, hum_low: 40,
    pres_high: 1015, pres_low: 1010,
    ...over,
  };
}

/** Store rows in the test database. */
export function insertRows(rows: WeatherRow[]): void {
  const stmt = upsertStmt('weather', COLUMNS);
  for (const r of rows) stmt.run(r.date, ...FIELDS.map(f => r[f]));
}
