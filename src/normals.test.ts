import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNormals, MD_AXIS } from './normals';
import { PublicRow } from './db';

const day = (date: string, v: Partial<PublicRow> = {}): PublicRow =>
  ({ date, temp_high: null, temp_low: null, wind_high: null, precip: null, ...v });

test('MD_AXIS is every calendar day, 29 Feb included', () => {
  assert.equal(MD_AXIS.length, 366);
  assert.equal(MD_AXIS[0], '01-01');
  assert.ok(MD_AXIS.includes('02-29'));
  assert.equal(MD_AXIS[365], '12-31');
});

test('without smoothing, each calendar day is the mean across years', () => {
  const n = computeNormals([
    day('1991-07-01', { temp_high: 24, precip: 0 }),
    day('1992-07-01', { temp_high: 28, precip: 6 }),
    day('1993-07-01', { temp_high: 26, precip: null }), // a gap is skipped, not zero
  ], 0);
  const jul1 = n.find(r => r.md === '07-01')!;
  assert.equal(jul1.temp_high, 26);
  assert.equal(jul1.precip, 3);
  assert.equal(jul1.wind_high, null);
  assert.equal(n.find(r => r.md === '07-02')!.temp_high, null);
});

test('smoothing averages the neighbouring days and wraps the year end', () => {
  const rows = [day('1991-12-31', { temp_high: 0 }), day('1992-01-01', { temp_high: 6 }), day('1992-01-02', { temp_high: 3 })];
  const n = computeNormals(rows, 1);
  const at = (md: string) => n.find(r => r.md === md)!.temp_high;
  assert.equal(at('01-01'), 3);   // (0 + 6 + 3) / 3, reaching back into 31 Dec
  assert.equal(at('12-31'), 3);   // (0 + 6) / 2, reaching forward into 1 Jan; 30 Dec has no data
  assert.equal(at('06-15'), null);
});
