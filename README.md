# 🌦 Weather Dashboard

A single-page dashboard for a personal weather station. Import the raw
export from your station, and browse temperature, humidity, wind, pressure,
precipitation and dew point across any time window — then compare your
readings against a public weather service.

Built entirely in **TypeScript** — Express on the back end and a compiled
TypeScript front end (no framework, no bundler). Storage is a local SQLite file
via Node's **built-in** `node:sqlite` module — no native addons, no database
server to run.

![Dashboard](dashboard.png)

## Features

- **Flexible time windows** — view a single **Day**, **Week**, **Month**,
  **Year**, or a **custom Range** between any two recorded dates. The Range
  pickers only offer dates that actually exist in your data, and an **All**
  toggle spans the entire dataset in one click.
- **At-a-glance stats** — high/avg/low cards for every metric, plus totals
  like accumulated precipitation and number of rainy days.
- **Interactive charts** — temperature, precipitation, humidity, pressure and
  wind rendered with Chart.js.
- **Compare vs. a public station** — overlay your readings against
  [Open-Meteo](https://open-meteo.com/) data for a reference location
  (Baar, CH by default) with a per-metric difference summary.
- **One-click re-import** — drop in a fresh station export and hit **↻ Import**;
  ingestion is idempotent, so re-importing never duplicates rows.

## Requirements

- **Node.js 22 or newer** (development uses Node 24). This is required for the
  built-in `node:sqlite` module — the app does **not** use better-sqlite3 or
  any native addon.

## Getting started

```bash
npm install
npm run dev
```

Then open **http://localhost:3000**. The server auto-imports `weather_data.txt`
on startup, so the dashboard lands on populated data immediately.

Set `PORT` to bind a different port:

```bash
PORT=8080 npm run dev
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Compile the front end, then run the server with `ts-node` → http://localhost:3000 |
| `npm run build` | Compile the server (`src/` → `dist/`) and the client (`src/client/app.ts` → `public/app.js`) |
| `npm run build:client` | Compile only the front end → `public/app.js` |
| `npm start` | Run the compiled server (`node dist/server.js`; requires `build` first) |
| `npm run import` | Re-parse `weather_data.txt` into `weather.db` from the CLI |
| `npm run screenshot` | Run the Playwright verification harness (server must be up) |

## Data format

Weather readings live in `weather_data.txt`, a tab-separated export with a
title line, two header rows, then one row per day. Dates are `MM/DD/YYYY`, and
each row carries 16 columns: high/avg/low for temperature, dew point, humidity
and wind speed, high/low for pressure, and a precipitation sum.

Importing is **idempotent** — rows are keyed on their unique `date` via
`INSERT OR REPLACE`, so re-running an import updates existing days rather than
duplicating them. Replace the file with your own station's export and either
restart the server or click **↻ Import** in the UI.

## API

The front end is a thin client over these routes; each period route returns
`{ rows, stats }`.

| Route | Description |
| --- | --- |
| `GET /api/day?date=YYYY-MM-DD` | A single day |
| `GET /api/week?year=&week=` | An ISO week |
| `GET /api/month?year=&month=` | A calendar month |
| `GET /api/year?year=` | A full year |
| `GET /api/range?from=&to=` | Any inclusive date range |
| `GET /api/compare?from=&to=` | Your data aligned with Open-Meteo for the reference location |
| `GET /api/dates` | All available dates |
| `GET /api/status` | Last import time + record count |
| `POST /api/import` | Re-import `weather_data.txt` (idempotent) |

## Project layout

```
src/
  db.ts          SQLite access (node:sqlite), query helpers, stat aggregation
  import.ts      Parses weather_data.txt → weather.db
  server.ts      Express routes over db.ts
  client/
    app.ts       All UI state, charts, and view toggling — no framework
public/
  index.html     Dashboard markup (Bootstrap + Chart.js from CDN)
  app.js         Compiled from src/client/app.ts (generated, git-ignored)
  style.css      Dark-theme styling
screenshot.ts      Playwright verification harness
weather_data.txt   Raw station export (the import source)
weather.db         SQLite database (generated)
```

**Everything is TypeScript.** The front end compiles from `src/client/app.ts`
to `public/app.js` with `tsc` (no bundler); `public/` is otherwise served as-is
with Bootstrap / Chart.js from a CDN. After editing `src/client/app.ts`, run
`npm run build:client` (or restart `npm run dev`, which does it) and refresh the
browser. After editing anything under `src/`, restart the dev server. Editing
`public/index.html` or `public/style.css` only needs a browser refresh.

## Verification

There is no unit-test runner. `screenshot.mjs` is the de-facto verification
harness: it drives the running server with Playwright, asserts the charts
populate, captures screenshots, and reports any console errors.

```bash
npx playwright install chromium   # once
npm run dev &                     # server must be up first
npm run screenshot                # writes dashboard*.png
```
