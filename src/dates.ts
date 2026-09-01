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

export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Calendar parts → the `YYYY-MM-DD` key every stored date uses. */
export const ymd = (year: number, month: number, day: number): string =>
  `${year}-${pad2(month)}-${pad2(day)}`;

/** A `Date` as its UTC `YYYY-MM-DD` day. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
