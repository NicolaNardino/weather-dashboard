import express, { Request, Response } from 'express';
import path from 'path';
import { dayCount, eachDay, isoDay, mdOf, ymd } from './dates';
import { computeNormals, MD_AXIS, NormalRow, NORMALS_PERIOD } from './normals';
import { DATA_FILE, describeImport, importFile } from './import';
import type {
  AcrossYearsReply, CompareReply, ImportReply, PeriodReply,
  PrecipYtdReply, StatusReply, YoyUnitKey,
} from './shapes';
import {
  queryWindow, coverage, Window,
  dayWindow, weekWindow, monthWindow, yearWindow,
  queryAllDates, queryYears, aggregateStats, getMeta, precipYtd,
  queryPublicRange, upsertPublic, PublicRow, PublicField, fieldRow,
  queryNormals, upsertNormals,
} from './db';

// Baar, Canton Zug, Switzerland — reference location for the public comparison.
const BAAR = { lat: 47.196, lon: 8.529, label: 'Baar, CH' };

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** "Mar" for 3, falling back to the bare number for anything out of range. */
const monthName = (m: number) => MONTH_NAMES[m - 1] ?? `Month ${m}`;

/**
 * The Open-Meteo daily series behind each cached field. Naming the pair once
 * means the request's `daily=` list and the response's parallel arrays are read
 * from the same table, rather than two hand-kept lists of the same four series.
 */
const OPEN_METEO_DAILY: Record<PublicField, string> = {
  temp_high: 'temperature_2m_max',
  temp_low: 'temperature_2m_min',
  wind_high: 'wind_speed_10m_max',
  precip: 'precipitation_sum',
};

/** Open-Meteo's two daily endpoints: recent days and forecasts, and the ERA5
    reanalysis archive going back to 1940 that the long-term normals come from. */
const OPEN_METEO = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
};

// Fetch daily data for Baar from Open-Meteo, normalized to PublicRow[].
async function fetchOpenMeteo(
  from: string, to: string, base: string = OPEN_METEO.forecast,
): Promise<PublicRow[]> {
  const url =
    `${base}?latitude=${BAAR.lat}&longitude=${BAAR.lon}` +
    `&daily=${Object.values(OPEN_METEO_DAILY).join(',')}` +
    `&timezone=Europe%2FZurich&start_date=${from}&end_date=${to}`;

  // A timeout, so an unreachable service fails the request instead of stalling it.
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Open-Meteo responded ${r.status}`);
  const j = (await r.json()) as { daily?: Record<string, unknown[]> };
  const d = j.daily ?? {};
  const time = (d.time as string[]) ?? [];

  // Open-Meteo returns each measure as its own parallel array; a measure the
  // API omitted is missing rather than null, so every read needs the same
  // cast-and-default.
  return time.map((date, i) =>
    fieldRow('date', date, f => (d[OPEN_METEO_DAILY[f]] as number[] | undefined)?.[i] ?? null));
}

/**
 * Where a Compare reply's public side came from, as the flags that say so on the
 * wire. The cache/fetch decision below has exactly these three outcomes, and
 * each was spelled at the point of reply as a `{ cached, stale? }` pair that
 * `reply` then turned into flags and a source label — so a ternary and a
 * conditional spread stood between the outcome and what it means, and the two
 * outcomes that serve the cache each had to remember to say `cached: true`.
 */
const ORIGIN = {
  /** Every day of the window was already cached; the network was not touched. */
  cache: { cached: true, source: 'Open-Meteo' },
  network: { cached: false, source: 'Open-Meteo' },
  /** The fetch failed, so whatever was cached is served instead. */
  stale: { cached: true, stale: true, source: 'Open-Meteo (cached)' },
} as const;

type Origin = (typeof ORIGIN)[keyof typeof ORIGIN];

/** The one in-flight normals download, shared by concurrent requests. */
let normalsLoading: Promise<NormalRow[]> | null = null;
/** When the last download failed: offline, don't retry on every Compare view. */
let normalsFailedAt = 0;
const NORMALS_RETRY_MS = 10 * 60_000;

/**
 * Baar's long-term daily normals, from the local cache when it is complete —
 * otherwise downloaded once from the ERA5 archive (30 years of daily data in one
 * request), reduced to one row per calendar day, and cached for good: a normal
 * never changes, so after the first Compare view this never touches the network.
 */
async function baarNormals(): Promise<NormalRow[]> {
  const cached = queryNormals(BAAR.label);
  if (cached.length === MD_AXIS.length) return cached;
  if (Date.now() - normalsFailedAt < NORMALS_RETRY_MS) throw new Error('normals download failed recently');
  normalsLoading ??= (async () => {
    try {
      const rows = await fetchOpenMeteo(NORMALS_PERIOD.from, NORMALS_PERIOD.to, OPEN_METEO.archive);
      const normals = computeNormals(rows);
      upsertNormals(BAAR.label, normals);
      return normals;
    } catch (err) {
      normalsFailedAt = Date.now();
      throw err;
    }
  })().finally(() => { normalsLoading = null; });
  return normalsLoading;
}

/** The default reader: the param as given, an absent one as ''. */
const asString = (v: string | undefined): string => v ?? '';

/**
 * Read the named query params, answering 400 and returning null if any comes
 * back falsy. The message names them in order, e.g. "year and week required".
 *
 * `read` decides what falsy means: by default an absent or empty string, and
 * with `Number` a value that isn't a positive number (a period index is never
 * 0) — already converted, so the numeric routes need no second pass. The cast
 * on the default is unavoidable: `asString` only satisfies `T` in the `T =
 * string` case it is the default for.
 */
function requireQuery<T extends string | number = string>(
  req: Request,
  res: Response,
  names: string[],
  read: (v: string | undefined) => T = asString as (v: string | undefined) => T,
): Record<string, T> | null {
  const q = req.query as Record<string, string | undefined>;
  const vals = Object.fromEntries(names.map(n => [n, read(q[n])])) as Record<string, T>;
  if (names.some(n => !vals[n])) {
    res.status(400).json({ error: `${names.join(' and ')} required` });
    return null;
  }
  return vals;
}

/**
 * The period routes all share a shape: check params, turn them into the
 * period's calendar window, query its rows, add stats and the window's coverage
 * (which days it is missing).
 * `emptyIs404` is the one variation — the single-day route answers 404 rather
 * than an empty period, which used to mean spelling the whole shape out again.
 *
 * `read` is passed straight to `requireQuery`, so a route whose params are
 * period indexes says `read: Number` once and its handler receives numbers —
 * rather than each one re-converting with `+q.year` and a non-numeric value
 * slipping through as NaN.
 */
function rowsRoute<T extends string | number = string>(
  names: string[],
  window: (q: Record<string, T>) => Window,
  opts: { emptyIs404?: boolean; read?: (v: string | undefined) => T } = {},
) {
  return (req: Request, res: Response) => {
    const q = requireQuery<T>(req, res, names, opts.read);
    if (!q) return;
    const w = window(q);
    const found = queryWindow(w);
    if (opts.emptyIs404 && !found.length) return res.status(404).json({ error: 'no data' });
    res.json({
      rows: found,
      stats: aggregateStats(found),
      coverage: coverage(w, found),
    } satisfies PeriodReply);
  };
}

/**
 * One entry per year-over-year comparison unit: the params it needs, the label
 * it puts on the result, and one year's calendar window for it. Dispatching the
 * unit once here keeps a new unit to a single entry, instead of a three-arm
 * if/else that spelled out validation, labelling and querying separately.
 *
 * A window rather than the rows themselves, because the reply also says how
 * much of the period each year actually covers — which needs the period's
 * calendar length, not just the days that happen to be stored.
 */
interface YoyUnit {
  /** Query params that must be present and numeric. */
  needs: string[];
  label: (q: Record<string, number>) => string;
  /** One year's calendar window for this unit. */
  window: (q: Record<string, number>, year: number) => Window;
}

const YOY_UNITS: Record<YoyUnitKey, YoyUnit> = {
  day: {
    needs: ['month', 'day'],
    label: q => `${monthName(q.month)} ${q.day}`,
    window: (q, y) => dayWindow(ymd(y, q.month, q.day)),
  },
  week: {
    needs: ['week'],
    label: q => `Week ${q.week}`,
    window: (q, y) => weekWindow(y, q.week),
  },
  month: {
    needs: ['month'],
    label: q => monthName(q.month),
    window: (q, y) => monthWindow(y, q.month),
  },
};

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.static(path.join(process.cwd(), 'public')));

// GET /api/dates — list all available dates
app.get('/api/dates', (_req, res) => {
  res.json(queryAllDates());
});

// GET /api/status — data freshness (last import time + record count)
app.get('/api/status', (_req, res) => {
  res.json({
    last_import: getMeta('last_import') ?? null,
    records: queryAllDates().length,
  } satisfies StatusReply);
});

// GET /api/compare?from=YYYY-MM-DD&to=YYYY-MM-DD
// Aligns my recorded data against a public weather service (Open-Meteo) for Baar.
// Public data is cached locally in SQLite: past days are served straight from
// the cache (no network), only missing/volatile days trigger a fetch, and a
// network failure falls back to whatever is cached.
app.get('/api/compare', async (req, res) => {
  const q = requireQuery(req, res, ['from', 'to']);
  if (!q) return;
  const { from, to } = q;

  // The long-term normal for each day of the window. They are optional: if
  // they can't be had (first use while offline), the comparison still works.
  const normals = await baarNormals().catch(err => {
    console.warn('Could not load long-term normals:', err);
    return [] as NormalRow[];
  });
  const byMd = new Map(normals.map(n => [n.md, n]));
  const normalRows = eachDay(from, to).flatMap(date => {
    const n = byMd.get(mdOf(date));
    return n ? [fieldRow('date', date, f => n[f])] : [];
  });

  // Every reply pairs my rows with the public ones over the same window, and
  // says where the public side came from (see ORIGIN).
  const reply = (pub: PublicRow[], origin: Origin) =>
    res.json({
      location: BAAR.label,
      ...origin,
      mine: queryWindow({ from, to }),
      public: pub,
      normals: normalRows,
      normals_label: NORMALS_PERIOD.label,
    } satisfies CompareReply);

  const today = isoDay(new Date());
  const cached = queryPublicRange(BAAR.label, from, to);

  // Today/future are forecasts that keep changing — never trust the cache for
  // them. Past days are stable, so a cache hit means we can skip the network.
  // The cache holds at most one row per day in the window, so counting the rows
  // says whether any day is missing — no need to walk the calendar for it.
  const needsFetch = to >= today || cached.length < dayCount(from, to);
  if (!needsFetch) return reply(cached, ORIGIN.cache);

  try {
    const fetched = await fetchOpenMeteo(from, to);
    // Persist only the stable (past) days; leave volatile forecasts uncached.
    upsertPublic(BAAR.label, fetched.filter(r => r.date < today));
    reply(fetched, ORIGIN.network);
  } catch (err) {
    // Offline / rate-limited: serve whatever we have cached rather than failing.
    if (cached.length) return reply(cached, ORIGIN.stale);
    res.status(502).json({ error: String(err) });
  }
});

// GET /api/across-years — gather the SAME period across every year that has
// data, so the same day, week or month can be compared year-over-year:
//   ?unit=month&month=3        → March of each year
//   ?unit=week&week=12         → ISO week 12 of each year
//   ?unit=day&month=3&day=15   → 15 March of each year
// Each year is returned with its rows and aggregated stats; years with no data
// for that period are omitted, so with one year of data it degrades to one.
//
// Each year also carries `days: { recorded, total }` — the days behind its
// averages against the period's full calendar length. Unlike the period
// routes' `coverage`, this is NOT clipped to the recorded span: a March that is
// only 5 days old is complete as far as the station goes, but its averages
// still aren't comparable with a whole March, and that is what this view needs
// to say.
app.get('/api/across-years', (req, res) => {
  // Name the unit once: the same string picks the spec that answers the
  // request and labels the reply. Echoing `req.query.unit` back instead
  // returned whatever was asked for — an array, for a repeated `?unit=` —
  // where the lookup above had already settled on one key.
  // A key only if the table holds it: the lookup is typed as possibly absent so
  // the 400 below reads as the guard it is, rather than as a branch on a value
  // the types say cannot happen.
  const unit = String(req.query.unit ?? '') as YoyUnitKey;
  const spec: YoyUnit | undefined = YOY_UNITS[unit];
  // The units the message offers come from the table that answers them, rather
  // than a hand-kept copy of its keys that a fourth unit would leave behind.
  if (!spec) {
    const units = Object.keys(YOY_UNITS).join(', ');
    return res.status(400).json({ error: `unit must be one of: ${units}` });
  }

  const q = requireQuery(req, res, spec.needs, Number);
  if (!q) return;

  // One pass per year: a year with no rows for the period drops out, and one
  // with rows is reported there and then. Written as map/filter/map it needed
  // an intermediate `{ year, rows, total }` whose only job was to carry the
  // calendar length across the filter and be spread back out on the far side.
  const years = queryYears().flatMap(year => {
    const w = spec.window(q, year);
    const rows = queryWindow(w);
    if (!rows.length) return [];
    return [{
      year,
      rows,
      stats: aggregateStats(rows),
      days: { recorded: rows.length, total: dayCount(w.from, w.to) },
    }];
  });

  res.json({ unit, label: spec.label(q), years } satisfies AcrossYearsReply);
});

// GET /api/precip-ytd — the running precipitation total through each year that
// has data, one point per recorded day ({ md: 'MM-DD', total }), so the years
// can be overlaid on a shared Jan–Dec axis.
app.get('/api/precip-ytd', (_req, res) => {
  res.json({ years: precipYtd() } satisfies PrecipYtdReply);
});

/**
 * The five period routes, keyed by the period each serves — which is also the
 * path it answers on (`/api/<period>`), the same way the front-end's PERIODS
 * table already names its endpoint after its own key. Registered by hand they
 * were five `app.get` calls of one shape, each naming its period twice a line
 * apart: once as a literal in the path, once in the params it reads.
 *
 *   day    ?date=YYYY-MM-DD                — the one route that can 404
 *   week   ?year=2026&week=14
 *   month  ?year=2026&month=4
 *   year   ?year=2026
 *   range  ?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
const PERIOD_ROUTES = {
  day: rowsRoute(['date'], q => dayWindow(q.date), { emptyIs404: true }),
  week: rowsRoute(['year', 'week'], q => weekWindow(q.year, q.week), { read: Number }),
  month: rowsRoute(['year', 'month'], q => monthWindow(q.year, q.month), { read: Number }),
  year: rowsRoute(['year'], q => yearWindow(q.year), { read: Number }),
  range: rowsRoute(['from', 'to'], q => ({ from: q.from, to: q.to })),
};

for (const [period, handler] of Object.entries(PERIOD_ROUTES)) {
  app.get(`/api/${period}`, handler);
}

// POST /api/import — re-import weather_data.txt (idempotent)
app.post('/api/import', (_req, res) => {
  try {
    res.json({ ok: true, ...importFile(DATA_FILE) } satisfies ImportReply);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Started as the process entry point only, so the tests can import `app` and
// listen on a port of their own.
if (require.main === module) app.listen(PORT, () => {
  console.log(`Weather dashboard running at http://localhost:${PORT}`);
  // Auto-import on startup so fresh data is always loaded
  try {
    const r = importFile(DATA_FILE);
    console.log(`Loaded ${r.total} records from weather_data.txt ${describeImport(r)}`);
  } catch (err) {
    console.warn('Could not auto-import weather_data.txt:', err);
  }
});

export { app };
