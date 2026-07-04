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

export function importFile(filePath: string): number {
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

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let imported = 0;

  for (const raw of lines) {
    const cols = raw.trim().split('\t');
    if (!cols[0]) continue;

    const date = parseDate(cols[0]);
    if (!date) continue;
    if (cols.length < 16) continue;

    insert.run(
      date,
      parseNum(cols[1]),  parseNum(cols[2]),  parseNum(cols[3]),
      parseNum(cols[4]),  parseNum(cols[5]),  parseNum(cols[6]),
      parseNum(cols[7]),  parseNum(cols[8]),  parseNum(cols[9]),
      parseNum(cols[10]), parseNum(cols[11]), parseNum(cols[12]),
      parseNum(cols[13]), parseNum(cols[14]),
      parseNum(cols[15]),
    );
    imported++;
  }

  // Record when this import ran so the UI can show data freshness.
  setMeta('last_import', new Date().toISOString());

  return imported;
}

// CLI usage: ts-node src/import.ts
if (require.main === module) {
  const dataFile = path.join(process.cwd(), 'weather_data.txt');
  const count = importFile(dataFile);
  console.log(`Imported ${count} records into weather.db`);
}
