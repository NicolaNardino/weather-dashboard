import express from 'express';
import path from 'path';
import { importFile } from './import';
import {
  queryDay, queryWeek, queryMonth, queryYear, queryRange,
  queryAllDates, aggregateStats, getMeta, WeatherRow,
  queryPublicRange, upsertPublic, PublicRow,
  queryYearWindow, alignByMonthDay
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

  if (!missing.length && !hasVolatile) {
    return res.json({
      location: BAAR.label,
      source: 'Open-Meteo',
      cached: true,
      mine: queryRange(from, to),
      public: cached,
    });
  }

  try {
    const fetched = await fetchOpenMeteo(from, to);
    // Persist only the stable (past) days; leave volatile forecasts uncached.
    upsertPublic(BAAR.label, fetched.filter(r => r.date < today));
    res.json({
      location: BAAR.label,
      source: 'Open-Meteo',
      cached: false,
      mine: queryRange(from, to),
      public: fetched,
    });
  } catch (err) {
    // Offline / rate-limited: serve whatever we have cached rather than failing.
    if (cached.length) {
      return res.json({
        location: BAAR.label,
        source: 'Open-Meteo (cached)',
        cached: true,
        stale: true,
        mine: queryRange(from, to),
        public: cached,
      });
    }
    res.status(502).json({ error: String(err) });
  }
});

// GET /api/day?date=YYYY-MM-DD
app.get('/api/day', (req, res) => {
  const { date } = req.query as { date?: string };
  if (!date) return res.status(400).json({ error: 'date required' });
  const row = queryDay(date);
  if (!row) return res.status(404).json({ error: 'no data' });
  res.json({ rows: [row], stats: aggregateStats([row]) });
});

// GET /api/week?year=2026&week=14
app.get('/api/week', (req, res) => {
  const { year, week } = req.query as { year?: string; week?: string };
  if (!year || !week) return res.status(400).json({ error: 'year and week required' });
  const rows = queryWeek(+year, +week);
  res.json({ rows, stats: aggregateStats(rows) });
});

// GET /api/month?year=2026&month=4
app.get('/api/month', (req, res) => {
  const { year, month } = req.query as { year?: string; month?: string };
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  const rows = queryMonth(+year, +month);
  res.json({ rows, stats: aggregateStats(rows) });
});

// GET /api/year?year=2026
app.get('/api/year', (req, res) => {
  const { year } = req.query as { year?: string };
  if (!year) return res.status(400).json({ error: 'year required' });
  const rows = queryYear(+year);
  res.json({ rows, stats: aggregateStats(rows) });
});

// GET /api/yoy?a=2025&b=2026[&from=MM-DD&to=MM-DD]
// Year-over-year: the same MM-DD window in two different years, aligned on
// month-day so the two series share one x-axis. Stats are computed over the
// days present in BOTH years, so the comparison is not skewed by a year that
// simply has more recorded days in the window.
app.get('/api/yoy', (req, res) => {
  const { a, b, from, to } = req.query as { a?: string; b?: string; from?: string; to?: string };
  if (!a || !b) return res.status(400).json({ error: 'a and b (years) required' });

  const MD = /^\d{2}-\d{2}$/;
  const fromMd = from ?? '01-01';
  const toMd = to ?? '12-31';
  if (!MD.test(fromMd) || !MD.test(toMd)) return res.status(400).json({ error: 'from/to must be MM-DD' });
  if (fromMd > toMd) return res.status(400).json({ error: 'from must not be after to' });

  const rowsA = queryYearWindow(+a, fromMd, toMd);
  const rowsB = queryYearWindow(+b, fromMd, toMd);
  const points = alignByMonthDay(rowsA, rowsB);

  // Overlap only — both years have a row for that month-day.
  const both = points.filter(p => p.a && p.b);
  const overlapA = both.map(p => p.a as WeatherRow);
  const overlapB = both.map(p => p.b as WeatherRow);

  res.json({
    yearA: +a, yearB: +b, from: fromMd, to: toMd,
    points,
    daysA: rowsA.length,
    daysB: rowsB.length,
    overlapDays: both.length,
    statsA: aggregateStats(overlapA),
    statsB: aggregateStats(overlapB),
  });
});

// GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/range', (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const rows: WeatherRow[] = queryRange(from, to);
  res.json({ rows, stats: aggregateStats(rows) });
});

// POST /api/import — re-import weather_data.txt (idempotent)
app.post('/api/import', (_req, res) => {
  try {
    const dataFile = path.join(process.cwd(), 'weather_data.txt');
    const result = importFile(dataFile);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Weather dashboard running at http://localhost:${PORT}`);
  // Auto-import on startup so fresh data is always loaded
  try {
    const dataFile = path.join(process.cwd(), 'weather_data.txt');
    const r = importFile(dataFile);
    console.log(
      `Loaded ${r.total} records from weather_data.txt ` +
      `(${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged)`,
    );
  } catch (err) {
    console.warn('Could not auto-import weather_data.txt:', err);
  }
});
