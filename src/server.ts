import express, { Request, Response } from 'express';
import path from 'path';
import { DATA_FILE, describeImport, importFile } from './import';
import {
  queryDay, queryWeek, queryMonth, queryYear, queryRange,
  queryAllDates, aggregateStats, getMeta, WeatherRow,
  queryPublicRange, upsertPublic, PublicRow
} from './db';

// Baar, Canton Zug, Switzerland — reference location for the public comparison.
const BAAR = { lat: 47.196, lon: 8.529, label: 'Baar, CH' };

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
 * Read the named query params, answering 400 and returning null if any is
 * missing. The message names them in order, e.g. "year and week required".
 */
function requireQuery(req: Request, res: Response, names: string[]): Record<string, string> | null {
  const q = req.query as Record<string, string | undefined>;
  if (names.some(n => !q[n])) {
    res.status(400).json({ error: `${names.join(' and ')} required` });
    return null;
  }
  return Object.fromEntries(names.map(n => [n, q[n] as string]));
}

/** The period routes all share a shape: check params, query rows, add stats. */
function rowsRoute(names: string[], rows: (q: Record<string, string>) => WeatherRow[]) {
  return (req: Request, res: Response) => {
    const q = requireQuery(req, res, names);
    if (!q) return;
    const found = rows(q);
    res.json({ rows: found, stats: aggregateStats(found) });
  };
}

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

// GET /api/day?date=YYYY-MM-DD — the one period route that can 404
app.get('/api/day', (req, res) => {
  const q = requireQuery(req, res, ['date']);
  if (!q) return;
  const row = queryDay(q.date);
  if (!row) return res.status(404).json({ error: 'no data' });
  res.json({ rows: [row], stats: aggregateStats([row]) });
});

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
