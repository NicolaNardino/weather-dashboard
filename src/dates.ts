/**
 * Date helpers shared by the query layer and the routes.
 *
 * Both sides build the same two things — a zero-padded `YYYY-MM-DD` from
 * calendar parts, and the ISO day of a `Date` — and each spelled them out
 * itself: `db.ts` padded the month inline and kept a local `isoDate`, while
 * `server.ts` kept its own `pad2` and wrote `.toISOString().slice(0, 10)` twice
 * more. Reading a *piece* of a stored date back out went the same way, which is
 * what `mdOf` below is.
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
 * The `MM-DD` of a stored day — the within-year key the long-term normals are
 * keyed by, and the slot a day fills on a Jan–Dec axis.
 *
 * Four places cut it out of a date by character position: `normals.ts` both
 * where it builds its calendar axis and where it files a reading under one, the
 * Compare route where it reads a normal back out for a day of the window, and
 * the year-to-date rain totals where it labels each day's running figure. Each
 * says where to cut rather than what is being cut out, which is the same reason
 * `ymd` and `isoDay` above are named rather than spelled out.
 */
export const mdOf = (iso: string): string => iso.slice(5);

/**
 * A stored `YYYY-MM-DD` day as the `Date` at its UTC midnight — the inverse of
 * `isoDay`, and the one step the two helpers below open with. Each spelled the
 * `T00:00:00Z` suffix out itself, `dayCount` twice over — three places asserting
 * that a bare day string needs a time and a zone bolted on before a `Date` will
 * read it the way the rest of this file does.
 */
const utcDay = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** Milliseconds in a day — the divisor behind the day count below. */
const MS_PER_DAY = 86_400_000;

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

/**
 * The stored day after `iso` — "what has to come next for two days to be
 * consecutive", which is the only thing either caller wants to know.
 *
 * Both asked it the long way round. `eachDay` below carried a `Date` cursor and
 * converted it to a day twice per step, to produce a list of days it was handed
 * days to bound; and the wet/dry spells in `db.ts` asked whether `dayCount` of
 * the pair came to 2, which is a span measured in order to test an adjacency.
 */
export const nextDay = (iso: string): string => isoDay(addDays(utcDay(iso), 1));

/** How many calendar days `[from, to]` spans, both ends included. */
export const dayCount = (from: string, to: string): number =>
  Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / MS_PER_DAY) + 1;

/** Every `YYYY-MM-DD` day in `[from, to]`, both ends included; empty if from > to. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) days.push(d);
  return days;
}
