import express, { Request, Response } from 'express';
import path from 'path';
import { DATA_FILE, describeImport, importFile } from './import';
import {
  queryDayRows, queryWeek, queryMonth, queryYear, queryRange,
  queryAllDates, queryYears, aggregateStats, getMeta, WeatherRow,
  queryPublicRange, upsertPublic, PublicRow
} from './db';

// Baar, Canton Zug, Switzerland — reference location for the public comparison.
const BAAR = { lat: 47.196, lon: 8.529, label: 'Baar, CH' };

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** "Mar" for 3, falling back to the bare number for anything out of range. */
const monthName = (m: number) => MONTH_NAMES[m - 1] ?? `Month ${m}`;

const pad2 = (n: number) => String(n).padStart(2, '0');

// Every calendar day (YYYY-MM-DD) in [from, to] inclusive.
function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Fetch daily data for Baar from Open-Meteo, normalized to PublicRow[].
async function fetchOpenMeteo(from: string, to: string): Promise<PublicRow[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${BAAR.lat}&longitude=${BAAR.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
    `&timezone=Europe%2FZurich&start_date=${from}&end_date=${to}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo responded ${r.status}`);
  const j = (await r.json()) as { daily?: Record<string, unknown[]> };
  const d = j.daily ?? {};
  const time = (d.time as string[]) ?? [];

  // Open-Meteo returns each measure as its own parallel array; a measure the
  // API omitted is missing rather than null, so every read needs the same
  // cast-and-default.
  const at = (measure: string, i: number): number | null =>
    (d[measure] as number[] | undefined)?.[i] ?? null;

  return time.map((date, i) => ({
    date,
    temp_high: at('temperature_2m_max', i),
    temp_low: at('temperature_2m_min', i),
    wind_high: at('wind_speed_10m_max', i),
    precip: at('precipitation_sum', i),
  }));
}

/**
 * Read the named query params, answering 400 and returning null if any comes
 * back falsy. The message names them in order, e.g. "year and week required".
 *
 * `read` decides what falsy means: by default an absent or empty string, and
 * with `Number` a value that isn't a positive number (a period index is never
 * 0) — already converted, so the numeric routes need no second pass.
 */
function requireQuery<T extends string | number = string>(
  req: Request,
  res: Response,
  names: string[],
  read: (v: string | undefined) => T = (v => v ?? '') as (v: string | undefined) => T,
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
 */
function rowsRoute(
  names: string[],
  rows: (q: Record<string, string>) => WeatherRow[],
  opts: { emptyIs404?: boolean } = {},
) {
  return (req: Request, res: Response) => {
    const q = requireQuery(req, res, names);
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
  rows: (q: Record<string, number>) => (year: number) => WeatherRow[];
}

const YOY_UNITS: Record<string, YoyUnit> = {
  day: {
    needs: ['month', 'day'],
    label: q => `${monthName(q.month)} ${q.day}`,
    rows: q => y => queryDayRows(`${y}-${pad2(q.month)}-${pad2(q.day)}`),
  },
  week: {
    needs: ['week'],
    label: q => `Week ${q.week}`,
    rows: q => y => queryWeek(y, q.week),
  },
  month: {
    needs: ['month'],
    label: q => monthName(q.month),
    rows: q => y => queryMonth(y, q.month),
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

  const today = new Date().toISOString().slice(0, 10);
  const wanted = eachDate(from, to);
  const cached = queryPublicRange(BAAR.label, from, to);
  const cachedDates = new Set(cached.map(r => r.date));

  // Today/future are forecasts that keep changing — never trust the cache for
  // them. Past days are stable, so a cache hit means we can skip the network.
  const hasVolatile = wanted.some(d => d >= today);
  const missing = wanted.filter(d => d < today && !cachedDates.has(d));

  if (!missing.length && !hasVolatile) return reply(cached, { cached: true });

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
  const spec = YOY_UNITS[String(req.query.unit ?? '')];
  if (!spec) return res.status(400).json({ error: 'unit must be day, week or month' });

  const q = requireQuery(req, res, spec.needs, Number);
  if (!q) return;

  const rowsFor = spec.rows(q);
  const years = queryYears()
    .map(year => ({ year, rows: rowsFor(year) }))
    .filter(x => x.rows.length)
    .map(x => ({ ...x, stats: aggregateStats(x.rows) }));

  res.json({ unit: req.query.unit, label: spec.label(q), years });
});

// GET /api/day?date=YYYY-MM-DD — the one period route that can 404
app.get('/api/day', rowsRoute(['date'], q => queryDayRows(q.date), { emptyIs404: true }));

// GET /api/week?year=2026&week=14
app.get('/api/week', rowsRoute(['year', 'week'], q => queryWeek(+q.year, +q.week)));

// GET /api/month?year=2026&month=4
app.get('/api/month', rowsRoute(['year', 'month'], q => queryMonth(+q.year, +q.month)));

// GET /api/year?year=2026
app.get('/api/year', rowsRoute(['year'], q => queryYear(+q.year)));

// GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/range', rowsRoute(['from', 'to'], q => queryRange(q.from, q.to)));

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
