# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # ts-node src/server.ts → http://localhost:3000 (primary dev command)
npm run build    # tsc → compiles src/ to dist/
npm start        # node dist/server.js (requires build first)
npm run import    # ts-node src/import.ts — re-parse weather_data.txt into weather.db from the CLI
```

There is **no test runner or linter configured**. `screenshot.mjs` is the de-facto verification harness: it drives the running server with Playwright, asserts charts populate, captures `dashboard*.png`, and reports console errors. Run it against a live server:

```bash
npm run dev &                        # server must be up first
node screenshot.mjs                  # writes dashboard.png / dashboard-month.png / dashboard-year.png
```

Playwright needs its browser installed once: `npx playwright install chromium`. Scripts that `import 'playwright'` must run from the project root so `node_modules` resolves.

The dev server binds port 3000. It does not hot-reload TypeScript — after editing anything in `src/`, kill the `ts-node src/server.ts` process and restart `npm run dev`. Editing files in `public/` needs only a browser refresh (served statically, no build step).

## Architecture

Single-page weather dashboard for a personal weather station. Express + TypeScript backend, vanilla-JS frontend, SQLite storage. No frontend build tooling — `public/` is served as-is and Bootstrap/Chart.js load from CDN.

**Data flow:** `weather_data.txt` (tab-separated, `MM/DD/YYYY` dates, 16 columns) → `import.ts` parses it → `weather.db`. The server **auto-imports on startup** and again on `POST /api/import`; both paths are idempotent via `INSERT OR REPLACE` keyed on the unique `date` column, so re-importing never duplicates. The frontend's `↻ Import` button hits that endpoint to reload after the file changes.

**SQLite via `node:sqlite`:** `db.ts` uses Node's built-in `DatabaseSync` (`import ... from 'node:sqlite'`) — **not** better-sqlite3 or any native addon. This requires **Node 22+** (dev runs Node 24). The DB file, WAL, and shm are created on first `getDb()` call. There is also a `meta` key/value table used only for `last_import` (see `getMeta`/`setMeta`).

**Layers:**
- `src/db.ts` — the only SQLite access. Query helpers (`queryDay/Week/Month/Year/Range`), `aggregateStats()` which computes the stat-card numbers, and the `WeatherRow` interface that flows unchanged to the frontend.
- `src/server.ts` — thin Express routes over `db.ts`. Each period route returns `{ rows, stats }`. `GET /api/compare` is the one route that reaches the network: it fetches Open-Meteo daily data for **Baar, CH** (hardcoded `BAAR` coords) server-side to avoid browser CORS, and returns it aligned with local rows.
- `public/app.js` — vanilla JS, no framework. Holds all UI state (`period`, `allDates`, `lastRows`), builds Chart.js charts, and toggles between `#dashboard-view` and `#compare-view`.

**Two frontend conventions worth knowing:**
- `refDate()` returns the *latest date that actually has data*, not calendar today. Period selectors default to this so a fresh load lands on populated data — important because the dataset can lag real-world "today" and defaulting to `new Date()` would show an empty dashboard.
- Bootstrap dark-mode tokens (`text-muted`, `bg-secondary-subtle`) only resolve correctly because `<html>` sets `data-bs-theme="dark"`. Without it these render as dark-on-dark and become unreadable; `public/style.css` layers explicit colors on top for the stat cards and chart titles.

**External dependency:** the Compare view is the only feature that calls out to the internet (Open-Meteo). It degrades gracefully to a status message when the fetch fails (offline / rate-limited).
