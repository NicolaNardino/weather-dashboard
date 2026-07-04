import fs from 'fs';
import path from 'path';
import { getDb, setMeta } from './db';

function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, '').replace(/[^\d.-]/g, ''));
}

function parseDate(s: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export interface ImportResult {
  total: number;      // valid data rows found in the file
  inserted: number;   // dates not previously in the DB
  updated: number;    // dates that existed but whose values changed
  unchanged: number;  // dates already present with identical values
}

// Fields (in insert order) used to detect whether an existing row changed.
const FIELDS = [
  'temp_high', 'temp_avg', 'temp_low',
  'dew_high', 'dew_avg', 'dew_low',
  'hum_high', 'hum_avg', 'hum_low',
  'wind_high', 'wind_avg', 'wind_low',
  'pres_high', 'pres_low', 'precip',
] as const;

export function importFile(filePath: string): ImportResult {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO weather
      (date, temp_high, temp_avg, temp_low,
       dew_high, dew_avg, dew_low,
       hum_high, hum_avg, hum_low,
       wind_high, wind_avg, wind_low,
       pres_high, pres_low, precip)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // Snapshot existing rows up front so we can tell new/changed from unchanged.
  const existing = new Map<string, Record<string, number>>();
  for (const r of db.prepare('SELECT * FROM weather').all() as Record<string, number>[]) {
    existing.set(r.date as unknown as string, r);
  }

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const result: ImportResult = { total: 0, inserted: 0, updated: 0, unchanged: 0 };

  for (const raw of lines) {
    const cols = raw.trim().split('\t');
    if (!cols[0]) continue;

    const date = parseDate(cols[0]);
    if (!date) continue;
    if (cols.length < 16) continue;

    const values = [
      parseNum(cols[1]),  parseNum(cols[2]),  parseNum(cols[3]),
      parseNum(cols[4]),  parseNum(cols[5]),  parseNum(cols[6]),
      parseNum(cols[7]),  parseNum(cols[8]),  parseNum(cols[9]),
      parseNum(cols[10]), parseNum(cols[11]), parseNum(cols[12]),
      parseNum(cols[13]), parseNum(cols[14]),
      parseNum(cols[15]),
    ];

    const prev = existing.get(date);
    if (!prev) {
      result.inserted++;
    } else if (FIELDS.some((f, i) => prev[f] !== values[i])) {
      result.updated++;
    } else {
      result.unchanged++;
      result.total++;
      continue; // nothing to write for an identical row
    }

    insert.run(date, ...values);
    result.total++;
  }

  // Record when this import ran so the UI can show data freshness.
  setMeta('last_import', new Date().toISOString());

  return result;
}

// CLI usage: ts-node src/import.ts
if (require.main === module) {
  const dataFile = path.join(process.cwd(), 'weather_data.txt');
  const r = importFile(dataFile);
  console.log(
    `Imported ${r.total} records into weather.db ` +
    `(${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged)`,
  );
}
