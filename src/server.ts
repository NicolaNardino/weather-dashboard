import express, { Request, Response } from 'express';
import path from 'path';
import { dayCount, isoDay, ymd } from './dates';
import { DATA_FILE, describeImport, importFile } from './import';
import {
  queryDayRows, queryWeek, queryMonth, queryYear, queryRange,
  queryAllDates, queryYears, aggregateStats, getMeta, WeatherRow,
  queryPublicRange, upsertPublic, PublicRow, PublicField, PUBLIC_FIELDS
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

// Fetch daily data for Baar from Open-Meteo, normalized to PublicRow[].
async function fetchOpenMeteo(from: string, to: string): Promise<PublicRow[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${BAAR.lat}&longitude=${BAAR.lon}` +
    `&daily=${Object.values(OPEN_METEO_DAILY).join(',')}` +
    `&timezone=Europe%2FZurich&start_date=${from}&end_date=${to}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo responded ${r.status}`);
  const j = (await r.json()) as { daily?: Record<string, unknown[]> };
  const d = j.daily ?? {};
  const time = (d.time as string[]) ?? [];

  // Open-Meteo returns each measure as its own parallel array; a measure the
  // API omitted is missing rather than null, so every read needs the same
  // cast-and-default.
  return time.map((date, i) => ({
    date,
    ...Object.fromEntries(PUBLIC_FIELDS.map(f =>
      [f, (d[OPEN_METEO_DAILY[f]] as number[] | undefined)?.[i] ?? null],
    )),
  })) as PublicRow[];
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
 * The period routes all share a shape: check params, query rows, add stats.
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
  rows: (q: Record<string, T>) => WeatherRow[],
  opts: { emptyIs404?: boolean; read?: (v: string | undefined) => T } = {},
) {
  return (req: Request, res: Response) => {
    const q = requireQuery<T>(req, res, names, opts.read);
    if (!q) return;
    const found = rows(q);
    if (opts.emptyIs404 && !found.length) return res.status(404).json({ error: 'no data' });
    res.json({ rows: found, stats: aggregateStats(found) });
  };
}

/**
 * One entry per year-over-year comparison unit: the params it needs, the label
 * it puts on the result, and how to gather one year's rows. Dispatching the
 * unit once here keeps a new unit to a single entry, instead of a three-arm
 * if/else that spelled out validation, labelling and querying separately.
 */
interface YoyUnit {
  /** Query params that must be present and numeric. */
  needs: string[];
  label: (q: Record<string, number>) => string;
  /** One year's rows for this unit. */
  rows: (q: Record<string, number>, year: number) => WeatherRow[];
}

const YOY_UNITS: Record<string, YoyUnit> = {
  day: {
    needs: ['month', 'day'],
    label: q => `${monthName(q.month)} ${q.day}`,
    rows: (q, y) => queryDayRows(ymd(y, q.month, q.day)),
  },
  week: {
    needs: ['week'],
    label: q => `Week ${q.week}`,
    rows: (q, y) => queryWeek(y, q.week),
  },
  month: {
    needs: ['month'],
    label: q => monthName(q.month),
    rows: (q, y) => queryMonth(y, q.month),
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
  });
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

  // Every reply pairs my rows with the public ones over the same window.
  const reply = (pub: PublicRow[], opts: { cached: boolean; stale?: boolean }) =>
    res.json({
      location: BAAR.label,
      source: opts.stale ? 'Open-Meteo (cached)' : 'Open-Meteo',
      cached: opts.cached,
      ...(opts.stale ? { stale: true } : {}),
      mine: queryRange(from, to),
      public: pub,
    });

  const today = isoDay(new Date());
  const cached = queryPublicRange(BAAR.label, from, to);

  // Today/future are forecasts that keep changing — never trust the cache for
  // them. Past days are stable, so a cache hit means we can skip the network.
  // The cache holds at most one row per day in the window, so counting the rows
  // says whether any day is missing — no need to walk the calendar for it.
  const needsFetch = to >= today || cached.length < dayCount(from, to);
  if (!needsFetch) return reply(cached, { cached: true });

  try {
    const fetched = await fetchOpenMeteo(from, to);
    // Persist only the stable (past) days; leave volatile forecasts uncached.
    upsertPublic(BAAR.label, fetched.filter(r => r.date < today));
    reply(fetched, { cached: false });
  } catch (err) {
    // Offline / rate-limited: serve whatever we have cached rather than failing.
    if (cached.length) return reply(cached, { cached: true, stale: true });
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
app.get('/api/across-years', (req, res) => {
  // Name the unit once: the same string picks the spec that answers the
  // request and labels the reply. Echoing `req.query.unit` back instead
  // returned whatever was asked for — an array, for a repeated `?unit=` —
  // where the lookup above had already settled on one key.
  const unit = String(req.query.unit ?? '');
  const spec = YOY_UNITS[unit];
  // The units the message offers come from the table that answers them, rather
  // than a hand-kept copy of its keys that a fourth unit would leave behind.
  if (!spec) {
    const units = Object.keys(YOY_UNITS).join(', ');
    return res.status(400).json({ error: `unit must be one of: ${units}` });
  }

  const q = requireQuery(req, res, spec.needs, Number);
  if (!q) return;

  const years = queryYears()
    .map(year => ({ year, rows: spec.rows(q, year) }))
    .filter(x => x.rows.length)
    .map(x => ({ ...x, stats: aggregateStats(x.rows) }));

  res.json({ unit, label: spec.label(q), years });
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
  day: rowsRoute(['date'], q => queryDayRows(q.date), { emptyIs404: true }),
  week: rowsRoute(['year', 'week'], q => queryWeek(q.year, q.week), { read: Number }),
  month: rowsRoute(['year', 'month'], q => queryMonth(q.year, q.month), { read: Number }),
  year: rowsRoute(['year'], q => queryYear(q.year), { read: Number }),
  range: rowsRoute(['from', 'to'], q => queryRange(q.from, q.to)),
};

for (const [period, handler] of Object.entries(PERIOD_ROUTES)) {
  app.get(`/api/${period}`, handler);
}

// POST /api/import — re-import weather_data.txt (idempotent)
app.post('/api/import', (_req, res) => {
  try {
    res.json({ ok: true, ...importFile(DATA_FILE) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Weather dashboard running at http://localhost:${PORT}`);
  // Auto-import on startup so fresh data is always loaded
  try {
    const r = importFile(DATA_FILE);
    console.log(`Loaded ${r.total} records from weather_data.txt ${describeImport(r)}`);
  } catch (err) {
    console.warn('Could not auto-import weather_data.txt:', err);
  }
});
