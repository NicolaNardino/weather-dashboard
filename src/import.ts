import fs from 'fs';
import path from 'path';
import { COLUMNS, Field, FIELDS, queryAllRows, setMeta, upsertStmt } from './db';

/** Strip units/thousands separators, keeping only what parseFloat reads. */
function parseNum(s: string): number {
  return parseFloat(s.replace(/[^\d.-]/g, ''));
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

export function importFile(filePath: string): ImportResult {
  const insert = upsertStmt('weather', COLUMNS);

  // Snapshot existing rows up front so we can tell new/changed from unchanged.
  const existing = new Map<string, Record<Field, number>>(
    queryAllRows().map(r => [r.date, r]),
  );

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const result: ImportResult = { total: 0, inserted: 0, updated: 0, unchanged: 0 };

  for (const raw of lines) {
    const cols = raw.trim().split('\t');
    if (!cols[0]) continue;

    const date = parseDate(cols[0]);
    if (!date) continue;
    if (cols.length < 16) continue;

    // cols[0] is the date; the remaining 15 line up with FIELDS.
    const values = FIELDS.map((_, i) => parseNum(cols[i + 1]));

    const prev = existing.get(date);
    result.total++;
    if (!prev) {
      result.inserted++;
    } else if (FIELDS.some((f, i) => prev[f] !== values[i])) {
      result.updated++;
    } else {
      result.unchanged++;
      continue; // nothing to write for an identical row
    }

    insert.run(date, ...values);
  }

  // Record when this import ran so the UI can show data freshness.
  setMeta('last_import', new Date().toISOString());

  return result;
}

/** The data file the CLI and the server both import from. */
export const DATA_FILE = path.join(process.cwd(), 'weather_data.txt');

/** "(3 new, 1 updated, 265 unchanged)" — the tail of every import log line. */
export function describeImport(r: ImportResult): string {
  return `(${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged)`;
}

// CLI usage: ts-node src/import.ts
if (require.main === module) {
  const r = importFile(DATA_FILE);
  console.log(`Imported ${r.total} records into weather.db ${describeImport(r)}`);
}
