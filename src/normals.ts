import { eachDay } from './dates';
import { PUBLIC_FIELDS, PublicField, PublicRow, round } from './db';

/**
 * Long-term daily normals: for each calendar day (`MM-DD`), the mean of every
 * public measure over a 30-year reference period. The Compare view sets both my
 * readings and Baar's against them, so a period reads as "warmer / wetter than
 * usual" rather than only as "warmer than the public station".
 */
export type NormalRow = { md: string } & Record<PublicField, number | null>;

/** The WMO standard reference period, from Open-Meteo's ERA5 archive. */
export const NORMALS_PERIOD = {
  from: '1991-01-01',
  to: '2020-12-31',
  label: '1991–2020 (ERA5)',
};

/**
 * Every `MM-DD` of a leap year, in calendar order — so 29 Feb has a slot.
 *
 * Walked with `eachDay`, which is the module that already owns "everything
 * UTC, built once": this was the only calendar arithmetic left outside it, and
 * it re-derived the whole chain itself — that a year's days can be counted off
 * from 1 January, that 366 of them covers a leap year, and that a `Date` has to
 * go through `toISOString` before it reads as a stored day.
 */
export const MD_AXIS: string[] = eachDay('2024-01-01', '2024-12-31').map(d => d.slice(5));

/**
 * The mean of the values that are actually there, or null when none is — the one
 * arithmetic rule both passes below share. A missing measure is skipped rather
 * than counted as zero, which matters twice over: a day the archive has no
 * reading for would otherwise drag its own average down, and 29 Feb (which only
 * the leap years supply) would drag its neighbours' down through the smoothing.
 *
 * Both passes used to carry their own running total and count — one as a pair of
 * parallel arrays, the other as two `let`s inside the window loop — so the same
 * "skip the nulls, then divide" rule was written twice in two shapes.
 */
const meanOf = (values: readonly (number | null)[]): number | null => {
  let total = 0;
  let count = 0;
  for (const v of values) {
    if (v == null) continue;
    total += v;
    count++;
  }
  return count ? total / count : null;
};

/**
 * Daily normals from a run of daily rows spanning many years.
 *
 * Each calendar day is first averaged across the years, then smoothed with a
 * centred moving average of ±`halfWindow` days that wraps around the year end
 * (31 Dec sits next to 1 Jan). Thirty samples per day are too few on their own —
 * precipitation especially would give a jagged "normal" where one wet year
 * decides a date — and 29 Feb only has the leap years.
 */
export function computeNormals(rows: PublicRow[], halfWindow = 7): NormalRow[] {
  const slot = new Map(MD_AXIS.map((md, i) => [md, i]));
  const len = MD_AXIS.length;

  // Pass 1: every year's reading for a calendar day, collected into that day's
  // slot, then averaged — one figure per day per measure, or null for a day the
  // archive has nothing for.
  const daily = PUBLIC_FIELDS.map(f => {
    const samples: (number | null)[][] = MD_AXIS.map(() => []);
    for (const r of rows) {
      const i = slot.get(r.date.slice(5));
      if (i !== undefined) samples[i].push(r[f]);
    }
    return samples.map(meanOf);
  });

  // Pass 2: each day's figure smoothed over the ±halfWindow days around it,
  // wrapping at the year end.
  const offsets = Array.from({ length: halfWindow * 2 + 1 }, (_, k) => k - halfWindow);
  return MD_AXIS.map((md, i) => {
    const row = { md } as NormalRow;
    PUBLIC_FIELDS.forEach((f, fi) => {
      const smoothed = meanOf(offsets.map(k => daily[fi][(i + k + len) % len]));
      row[f] = smoothed == null ? null : round(smoothed);
    });
    return row;
  });
}
