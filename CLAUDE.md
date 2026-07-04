# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## TypeScript only — no plain JavaScript

**All code in this project MUST be written in TypeScript (`.ts`).** Do not add
`.js`, `.mjs`, or `.cjs` source files — this applies to the server, the CLI
tools, the browser front-end, and any helper/verification scripts. The only
`.js` in the repo is generated build output (`public/app.js`, compiled from
`src/client/app.ts`) and is git-ignored; never edit it by hand. If you need a
new script, write it in TypeScript and run it with `ts-node`.

## Commands

```bash
npm run dev          # build the client, then ts-node src/server.ts → http://localhost:3000 (primary dev command)
npm run build        # tsc (server → dist/) + tsc -p tsconfig.client.json (client → public/app.js)
npm run build:client # compile only src/client/app.ts → public/app.js
npm start            # node dist/server.js (requires build first)
npm run import       # ts-node src/import.ts — re-parse weather_data.txt into weather.db from the CLI
npm run screenshot   # ts-node --transpile-only screenshot.ts — the verification harness (server must be up)
```

There is **no test runner or linter configured**. `screenshot.ts` is the de-facto verification harness: it drives the running server with Playwright, asserts charts populate, captures `dashboard*.png`, and reports console errors. Run it against a live server:

```bash
npm run dev &        # server must be up first
npm run screenshot   # writes dashboard.png / dashboard-month.png / dashboard-year.png
```

Playwright needs its browser installed once: `npx playwright install chromium`. Scripts that `import 'playwright'` must run from the project root so `node_modules` resolves.

The dev server binds port 3000. It does not hot-reload TypeScript — after editing anything in `src/`, kill the `ts-node src/server.ts` process and restart `npm run dev`. The front-end is compiled: after editing `src/client/app.ts` run `npm run build:client` (or restart `npm run dev`, which does it) and refresh the browser. Editing the static assets in `public/` (`index.html`, `style.css`) needs only a browser refresh.

## Architecture

Single-page weather dashboard for a personal weather station. Express + TypeScript backend, TypeScript front-end (compiled to a single browser bundle), SQLite storage. The front-end has no bundler — `src/client/app.ts` compiles to `public/app.js` via `tsc`, and `public/` is otherwise served as-is with Bootstrap/Chart.js loaded from CDN.

**Data flow:** `weather_data.txt` (tab-separated, `MM/DD/YYYY` dates, 16 columns) → `import.ts` parses it → `weather.db`. The server **auto-imports on startup** and again on `POST /api/import`; both paths are idempotent via `INSERT OR REPLACE` keyed on the unique `date` column, so re-importing never duplicates. The frontend's `↻ Import` button hits that endpoint to reload after the file changes.

**SQLite via `node:sqlite`:** `db.ts` uses Node's built-in `DatabaseSync` (`import ... from 'node:sqlite'`) — **not** better-sqlite3 or any native addon. This requires **Node 22+** (dev runs Node 24). The DB file, WAL, and shm are created on first `getDb()` call. There is also a `meta` key/value table used only for `last_import` (see `getMeta`/`setMeta`).

**Layers:**
- `src/db.ts` — the only SQLite access. Query helpers (`queryDay/Week/Month/Year/Range`), `aggregateStats()` which computes the stat-card numbers, and the `WeatherRow` interface that flows unchanged to the frontend.
- `src/server.ts` — thin Express routes over `db.ts`. Each period route returns `{ rows, stats }`. `GET /api/compare` is the one route that reaches the network: it fetches Open-Meteo daily data for **Baar, CH** (hardcoded `BAAR` coords) server-side to avoid browser CORS, and returns it aligned with local rows. Fetched days are **cached locally** in the `public_weather` SQLite table (`queryPublicRange`/`upsertPublic` in `db.ts`): past days are served straight from the cache, only missing or volatile (today/future forecast) days trigger a fetch, and a network failure falls back to whatever is cached. The response carries `cached`/`stale` flags.
- `src/client/app.ts` — the front-end, no framework. Holds all UI state (`period`, `allDates`, `lastRows`), builds Chart.js charts, and toggles between `#dashboard-view` and `#compare-view`. Compiles to `public/app.js` (git-ignored) via `tsconfig.client.json` (DOM lib, ES2020 module, `Chart` declared as a global from the CDN).

**Two frontend conventions worth knowing:**
- `refDate()` returns the *latest date that actually has data*, not calendar today. Period selectors default to this so a fresh load lands on populated data — important because the dataset can lag real-world "today" and defaulting to `new Date()` would show an empty dashboard.
- Bootstrap dark-mode tokens (`text-muted`, `bg-secondary-subtle`) only resolve correctly because `<html>` sets `data-bs-theme="dark"`. Without it these render as dark-on-dark and become unreadable; `public/style.css` layers explicit colors on top for the stat cards and chart titles.

**External dependency:** the Compare view is the only feature that calls out to the internet (Open-Meteo). Results are cached in SQLite (see `/api/compare` above), so repeated views and offline use are served from the cache; if the fetch fails and nothing is cached for the range, it degrades gracefully to a status message.
