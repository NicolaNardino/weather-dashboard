import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row } from './test/helpers';
import {
  aggregateStats, climateDays, longestSpell, monthWindow, rainDays, weekWindow, yearWindow,
} from './db';

const wet = (date: string, precip = 2) => row(date, { precip });

test('aggregateStats is null for no rows', () => {
  assert.equal(aggregateStats([]), null);
});

test('aggregateStats reports extremes, means and precipitation', () => {
  const s = aggregateStats([
    row('2026-03-01', { temp_high: 12, temp_avg: 8, temp_low: 2, precip: 1.25 }),
    row('2026-03-02', { temp_high: 20, temp_avg: 13, temp_low: 6, precip: 0 }),
    row('2026-03-03', { temp_high: 16, temp_avg: 12, temp_low: -1, precip: 4.5 }),
  ])!;
  assert.deepEqual(s.temp, { high: 20, avg: 11, low: -1 });
  assert.deepEqual(s.precip, { total: 5.75, max: 4.5 });
  assert.deepEqual(s.rain, { days: 2, dry: 1, pct: 67 });
});

test('pressure averages each day\'s mid-point', () => {
  const s = aggregateStats([row('2026-03-01', { pres_high: 1020, pres_low: 1010 })])!;
  assert.equal(s.pressure.avg, 1015);
});

test('rainDays counts any precipitation, and is all-zero for no rows', () => {
  assert.deepEqual(rainDays([wet('2026-01-01', 0.1), row('2026-01-02')]), { days: 1, dry: 1, pct: 50 });
  assert.deepEqual(rainDays([]), { days: 0, dry: 0, pct: 0 });
});

test('climateDays uses the MeteoSwiss thresholds', () => {
  const c = climateDays([
    row('2026-01-01', { temp_high: -2, temp_low: -8 }), // ice (and frost)
    row('2026-01-02', { temp_high: 3, temp_low: -0.1 }), // frost only
    row('2026-01-03', { temp_high: 5, temp_low: 0 }),   // neither: 0 is not below 0
    row('2026-07-01', { temp_high: 25 }),               // summer
    row('2026-07-02', { temp_high: 30 }),               // hot (and summer)
    row('2026-07-03', { temp_high: 24.9 }),             // neither
  ]);
  assert.deepEqual(c, { frost: 2, ice: 1, summer: 2, hot: 1 });
});

test('the hot spell is the longest run of highs at 30 °C or more', () => {
  const s = aggregateStats([
    row('2026-07-01', { temp_high: 31 }),
    row('2026-07-02', { temp_high: 29.9 }),               // just below: ends the run
    row('2026-07-03', { temp_high: 30 }),                 // exactly 30 counts
    row('2026-07-04', { temp_high: 33 }),
    row('2026-07-05', { temp_high: 30.5 }),
    row('2026-07-07', { temp_high: 35 }),                 // after a missing day: a new run
  ])!;
  assert.deepEqual(s.spells.hot, { days: 3, from: '2026-07-03', to: '2026-07-05' });
  // The spell and the hot-day count share one definition of a hot day.
  assert.equal(s.climate.hot, 5);
  assert.deepEqual(aggregateStats([row('2026-07-01')])!.spells.hot, { days: 0, from: null, to: null });
});

test('longestSpell finds the longest consecutive run', () => {
  const rows = [
    wet('2026-03-01'), wet('2026-03-02'), row('2026-03-03'),
    wet('2026-03-04'), wet('2026-03-05'), wet('2026-03-06'), row('2026-03-07'),
  ];
  assert.deepEqual(longestSpell(rows, r => r.precip > 0), { days: 3, from: '2026-03-04', to: '2026-03-06' });
  assert.deepEqual(longestSpell(rows, r => r.precip === 0), { days: 1, from: '2026-03-03', to: '2026-03-03' });
});

test('longestSpell: a missing day ends a run', () => {
  const rows = [wet('2026-03-01'), wet('2026-03-02'), /* 03 missing */ wet('2026-03-04')];
  assert.deepEqual(longestSpell(rows, r => r.precip > 0), { days: 2, from: '2026-03-01', to: '2026-03-02' });
});

test('longestSpell keeps the earliest of equal runs, and reports none as null', () => {
  const rows = [wet('2026-03-01'), row('2026-03-02'), wet('2026-03-03')];
  assert.deepEqual(longestSpell(rows, r => r.precip > 0), { days: 1, from: '2026-03-01', to: '2026-03-01' });
  assert.deepEqual(longestSpell([row('2026-03-01')], r => r.precip > 0), { days: 0, from: null, to: null });
});

test('period windows', () => {
  assert.deepEqual(monthWindow(2026, 2), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthWindow(2024, 2), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(yearWindow(2026), { from: '2026-01-01', to: '2026-12-31' });
  // ISO week 1 of 2026 starts on Monday 29 Dec 2025.
  assert.deepEqual(weekWindow(2026, 1), { from: '2025-12-29', to: '2026-01-04' });
  assert.deepEqual(weekWindow(2026, 14), { from: '2026-03-30', to: '2026-04-05' });
});
