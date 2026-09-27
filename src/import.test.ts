import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { TMP_DIR } from './test/helpers';
import { importFile } from './import';
import { queryAllRows } from './db';

/** One data line in the station export's format: units, thousands separators, tabs. */
const line = (date: string, tempHigh: string, precip: string) =>
  [date, `${tempHigh} °C`, '20.0 °C', '10.8 °C', '12.3 °C', '8.9 °C', '6.4 °C',
    '84 %', '52 %', '26 %', '6.3 km/h', '0.3 km/h', '0.0 km/h',
    '1,014.22 hPa', '1,011.85 hPa', `${precip} mm`].join('\t');

const HEADER = [
  'September 1, 2026 - September 30, 2026',
  'Temperature\tDew Point\tHumidity\tSpeed\tPressure\tPrecip. Accum.',
  'Date\tHigh\tAvg\tLow\tHigh\tAvg\tLow\tHigh\tAvg\tLow\tHigh\tAvg\tLow\tHigh\tLow\tSum',
];

function writeExport(lines: string[]): string {
  const file = path.join(TMP_DIR, 'weather_data.txt');
  fs.writeFileSync(file, [...HEADER, ...lines].join('\n'));
  return file;
}

test('import parses the export, skipping header lines', () => {
  const r = importFile(writeExport([line('9/26/2026', '30.6', '0.00'), line('9/27/2026', '29.4', '1.25')]));
  assert.deepEqual(r, { total: 2, inserted: 2, updated: 0, unchanged: 0 });

  const rows = queryAllRows().sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(rows.map(x => x.date), ['2026-09-26', '2026-09-27']);
  assert.equal(rows[0].temp_high, 30.6);
  assert.equal(rows[0].pres_high, 1014.22);  // "1,014.22 hPa"
  assert.equal(rows[1].precip, 1.25);
});

test('re-importing is idempotent, and a changed day counts as updated', () => {
  const r = importFile(writeExport([
    line('9/26/2026', '30.6', '0.00'),   // unchanged
    line('9/27/2026', '29.4', '2.50'),   // precipitation corrected
    line('9/28/2026', '25.0', '0.00'),   // new
  ]));
  assert.deepEqual(r, { total: 3, inserted: 1, updated: 1, unchanged: 1 });
  assert.equal(queryAllRows().length, 3);
});
