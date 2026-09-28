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

/** Every `MM-DD` of a leap year, in calendar order — so 29 Feb has a slot. */
export const MD_AXIS: string[] = Array.from({ length: 366 }, (_, i) =>
  new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(5, 10));

/**
 * Daily normals from a run of daily rows spanning many years.
 *
 * Each calendar day is first averaged across the years, then smoothed with a
 * centred moving average of ±`halfWindow` days that wraps around the year end
 * (31 Dec sits next to 1 Jan). Thirty samples per day are too few on their own —
 * precipitation especially would give a jagged "normal" where one wet year
 * decides a date — and 29 Feb only has the leap years. A day with no samples
 * for a measure is skipped in the average rather than counted as zero.
 */
export function computeNormals(rows: PublicRow[], halfWindow = 7): NormalRow[] {
  const slot = new Map(MD_AXIS.map((md, i) => [md, i]));
  const raw = PUBLIC_FIELDS.map(f => {
    const sum = new Array<number>(MD_AXIS.length).fill(0);
    const n = new Array<number>(MD_AXIS.length).fill(0);
    for (const r of rows) {
      const i = slot.get(r.date.slice(5));
      const v = r[f];
      if (i === undefined || v == null) continue;
      sum[i] += v;
      n[i]++;
    }
    return sum.map((s, i) => (n[i] ? s / n[i] : null));
  });

  const len = MD_AXIS.length;
  return MD_AXIS.map((md, i) => {
    const row = { md } as NormalRow;
    PUBLIC_FIELDS.forEach((f, fi) => {
      let total = 0;
      let count = 0;
      for (let k = -halfWindow; k <= halfWindow; k++) {
        const v = raw[fi][(i + k + len) % len];
        if (v == null) continue;
        total += v;
        count++;
      }
      row[f] = count ? round(total / count) : null;
    });
    return row;
  });
}
