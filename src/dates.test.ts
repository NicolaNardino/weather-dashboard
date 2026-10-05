import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayCount, eachDay, isoDay, nextDay, ymd } from './dates';

test('ymd zero-pads month and day', () => {
  assert.equal(ymd(2026, 3, 7), '2026-03-07');
  assert.equal(ymd(2026, 12, 31), '2026-12-31');
});

test('addDays crosses month and year ends without mutating its input', () => {
  const d = new Date(Date.UTC(2025, 11, 31));
  assert.equal(isoDay(addDays(d, 1)), '2026-01-01');
  assert.equal(isoDay(addDays(d, -31)), '2025-11-30');
  assert.equal(isoDay(d), '2025-12-31');
});

test('nextDay crosses month, year and leap-day ends', () => {
  assert.equal(nextDay('2026-03-07'), '2026-03-08');
  assert.equal(nextDay('2026-02-28'), '2026-03-01');
  assert.equal(nextDay('2024-02-28'), '2024-02-29'); // leap year
  assert.equal(nextDay('2025-12-31'), '2026-01-01');
});

test('dayCount includes both ends', () => {
  assert.equal(dayCount('2026-03-01', '2026-03-01'), 1);
  assert.equal(dayCount('2026-02-01', '2026-03-01'), 29);
  assert.equal(dayCount('2024-02-01', '2024-03-01'), 30); // leap year
});

test('eachDay lists every day, and nothing when from > to', () => {
  assert.deepEqual(eachDay('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(eachDay('2026-01-02', '2026-01-01'), []);
});
