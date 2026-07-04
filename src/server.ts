import express from 'express';
import path from 'path';
import { importFile } from './import';
import {
  queryDay, queryWeek, queryMonth, queryYear, queryRange,
  queryAllDates, aggregateStats, getMeta, WeatherRow
} from './db';

// Baar, Canton Zug, Switzerland — reference location for the public comparison.
const BAAR = { lat: 47.196, lon: 8.529, label: 'Baar, CH' };

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
app.get('/api/compare', async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${BAAR.lat}&longitude=${BAAR.lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
      `&timezone=Europe%2FZurich&start_date=${from}&end_date=${to}`;

    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo responded ${r.status}`);
    const j = (await r.json()) as { daily?: Record<string, unknown[]> };
    const d = j.daily ?? {};
    const time = (d.time as string[]) ?? [];

    const publicRows = time.map((date, i) => ({
      date,
      temp_high: (d.temperature_2m_max as number[])?.[i] ?? null,
      temp_low: (d.temperature_2m_min as number[])?.[i] ?? null,
      wind_high: (d.wind_speed_10m_max as number[])?.[i] ?? null,
      precip: (d.precipitation_sum as number[])?.[i] ?? null,
    }));

    res.json({
      location: BAAR.label,
      source: 'Open-Meteo',
      mine: queryRange(from, to),
      public: publicRows,
    });
  } catch (err) {
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
