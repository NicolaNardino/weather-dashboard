import fs from 'fs';
import path from 'path';
import { ymd } from './dates';
import { COLUMNS, Field, FIELDS, queryAllRows, setMeta, upsertStmt } from './db';
import type { ImportResult } from './shapes';

// Re-exported from the layer that produces it, as db.ts does with the row
// shapes — the import button reads this straight off the wire.
export type { ImportResult } from './shapes';

/** Strip units/thousands separators, keeping only what parseFloat reads. */
function parseNum(s: string): number {
  return parseFloat(s.replace(/[^\d.-]/g, ''));
}

/** The file's `MM/DD/YYYY` date as the `YYYY-MM-DD` key the DB stores, or null. */
function parseDate(s: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? ymd(Number(m[3]), Number(m[1]), Number(m[2])) : null;
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
    // A short row is a header/footer line, not data. The width comes from
    // COLUMNS rather than a literal 16, which had to agree with FIELDS by hand.
    if (cols.length < COLUMNS.length) continue;

    // cols[0] is the date; the remaining 15 line up with FIELDS. Keyed by the
    // measure's own name rather than held as an array parallel to FIELDS, which
    // both the comparison below and the write then read back by index.
    const values = Object.fromEntries(
      FIELDS.map((f, i) => [f, parseNum(cols[i + 1])]),
    ) as Record<Field, number>;

    const prev = existing.get(date);
    result.total++;
    if (!prev) {
      result.inserted++;
    } else if (FIELDS.some(f => prev[f] !== values[f])) {
      result.updated++;
    } else {
      result.unchanged++;
      continue; // nothing to write for an identical row
    }

    insert.run({ date, ...values });
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
