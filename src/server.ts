import express, { RequestHandler } from 'express';
import path from 'path';
import { DATA_FILE, importFile } from './import';
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

  return time.map((date, i) => ({
    date,
    temp_high: (d.temperature_2m_max as number[])?.[i] ?? null,
    temp_low: (d.temperature_2m_min as number[])?.[i] ?? null,
    wind_high: (d.wind_speed_10m_max as number[])?.[i] ?? null,
    precip: (d.precipitation_sum as number[])?.[i] ?? null,
  }));
}

// The envelope every period route replies with.
const withStats = (rows: WeatherRow[]) => ({ rows, stats: aggregateStats(rows) });

/**
 * A period route. The five of them differ only in which query params they
 * require and which db query they run, so the required-param check and the
 * { rows, stats } reply live here once.
 */
function periodRoute(
  required: string[],
  query: (q: Record<string, string>) => WeatherRow[],
): RequestHandler {
  return (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (required.some(p => !q[p])) {
      return res.status(400).json({ error: `${required.join(' and ')} required` });
    }
    res.json(withStats(query(q as Record<string, string>)));
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
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const today = new Date().toISOString().slice(0, 10);
  const wanted = eachDate(from, to);
  const cached = queryPublicRange(BAAR.label, from, to);
  const cachedDates = new Set(cached.map(r => r.date));

  // Today/future are forecasts that keep changing — never trust the cache for
  // them. Past days are stable, so a cache hit means we can skip the network.
  const hasVolatile = wanted.some(d => d >= today);
  const missing = wanted.filter(d => d < today && !cachedDates.has(d));

  // All three exits (cache hit, fresh fetch, stale fallback) return the same
  // envelope; only the public rows and the cache flags differ.
  const reply = (publicRows: PublicRow[], flags: { cached: boolean; stale?: boolean }) =>
    res.json({
      location: BAAR.label,
      source: flags.stale ? 'Open-Meteo (cached)' : 'Open-Meteo',
      cached: flags.cached,
      ...(flags.stale ? { stale: true } : {}),
      mine: queryRange(from, to),
      public: publicRows,
    });

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

// GET /api/day?date=YYYY-MM-DD — the one period route that 404s on a miss.
app.get('/api/day', (req, res) => {
  const { date } = req.query as { date?: string };
  if (!date) return res.status(400).json({ error: 'date required' });
  const row = queryDay(date);
  if (!row) return res.status(404).json({ error: 'no data' });
  res.json(withStats([row]));
});

// GET /api/week?year=2026&week=14
app.get('/api/week', periodRoute(['year', 'week'], q => queryWeek(+q.year, +q.week)));

// GET /api/month?year=2026&month=4
app.get('/api/month', periodRoute(['year', 'month'], q => queryMonth(+q.year, +q.month)));

// GET /api/year?year=2026
app.get('/api/year', periodRoute(['year'], q => queryYear(+q.year)));

// GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/range', periodRoute(['from', 'to'], q => queryRange(q.from, q.to)));

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
    console.log(
      `Loaded ${r.total} records from weather_data.txt ` +
      `(${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged)`,
    );
  } catch (err) {
    console.warn('Could not auto-import weather_data.txt:', err);
  }
});
