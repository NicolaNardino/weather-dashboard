/**
 * Date helpers shared by the query layer and the routes.
 *
 * Both sides build the same two things — a zero-padded `YYYY-MM-DD` from
 * calendar parts, and the ISO day of a `Date` — and each spelled them out
 * itself: `db.ts` padded the month inline and kept a local `isoDate`, while
 * `server.ts` kept its own `pad2` and wrote `.toISOString().slice(0, 10)` twice
 * more.
 *
 * Everything here is UTC. Stored dates are compared as strings, so building
 * them in local time shifted them a day either side of midnight for anyone west
 * or east of UTC.
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Calendar parts → the `YYYY-MM-DD` key every stored date uses. */
export const ymd = (year: number, month: number, day: number): string =>
  `${year}-${pad2(month)}-${pad2(day)}`;

/** A `Date` as its UTC `YYYY-MM-DD` day. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * `d` shifted by `days`, as a new `Date` — the week query walked the calendar
 * twice by copying a date and then mutating the copy, which reads as two steps
 * and leaves a half-built date in scope between them.
 */
export const addDays = (d: Date, days: number): Date => {
  const shifted = new Date(d);
  shifted.setUTCDate(d.getUTCDate() + days);
  return shifted;
};

/** How many calendar days `[from, to]` spans, both ends included. */
export const dayCount = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
