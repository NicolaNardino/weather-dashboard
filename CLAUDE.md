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
npm test             # type-check the tests, then node:test over src/**/*.test.ts
```

**Tests** use Node's built-in `node:test` + `node:assert`, run through `ts-node` (no extra framework). `npm test` first type-checks them with `tsconfig.test.json` (the build's `tsconfig.json` excludes `*.test.ts` and `src/test/` so they never reach `dist/`), then runs every `src/**/*.test.ts`. Each test file imports `src/test/helpers.ts` **first**: it sets `WEATHER_DB` to a throwaway SQLite file before `db.ts` opens one, so tests never touch the real `weather.db`, and `node --test` gives every file its own process and database. `server.ts` only listens when it is the entry point and exports `app`, so `server.test.ts` drives real routes on an ephemeral port; its Compare test pre-fills the public-data and normals caches so it never reaches the network. There is **no linter configured**. `screenshot.ts` is the end-to-end verification harness: it drives the running server with Playwright, asserts every period renders with populated stat cards, checks the Year period draws the calendar heatmap and Across Years draws the year-to-date rain chart and labels each year with its recorded day count, captures `dashboard*.png`, and **exits non-zero** on any console error, page error, failed same-origin request, or empty stat card. Run it against a live server:

```bash
npm run dev &        # server must be up first
npm run screenshot   # writes dashboard.png / -month / -year / -yoy .png
```

Playwright needs its browser installed once: `npx playwright install chromium`. Scripts that `import 'playwright'` must run from the project root so `node_modules` resolves. Two env vars help in constrained environments: `PLAYWRIGHT_CHROMIUM_PATH` points the harness at an already-installed browser (when Playwright's CDN is unreachable), and `DASHBOARD_URL` overrides `http://localhost:3000`.

## CI

`.github/workflows/ci.yml` runs on push / PR to `main` under **Node 24** (matching the `node:sqlite` requirement):

1. **No plain JavaScript in source** — fails if any `.js`/`.mjs`/`.cjs` file is tracked by git, enforcing the rule at the top of this file. The generated `public/app.js` is gitignored, so it doesn't trip the check.
2. **`npm run build`** — `tsc` for the server and the client bundle. With no separate linter or `typecheck` script, this is the type-check gate.
3. **`npm test`** — the unit and route tests (offline, throwaway databases).
4. **`npm run import`** — parses the committed `weather_data.txt`, catching parser regressions against real fixture data and giving the server a populated DB.
5. **End-to-end** — boots `npm start` and runs `npm run screenshot` against it, so a broken dashboard fails the build. The screenshots upload as an artifact (on success *and* failure) for eyeballing UI changes in a PR.

The e2e step loads Bootstrap and Chart.js from a CDN, so a CDN outage will fail the run. That's deliberate — the dashboard genuinely doesn't work without them — but it's the most likely source of a flaky failure.

The dev server binds port 3000. It does not hot-reload TypeScript — after editing anything in `src/`, kill the `ts-node src/server.ts` process and restart `npm run dev`. The front-end is compiled: after editing `src/client/app.ts` run `npm run build:client` (or restart `npm run dev`, which does it) and refresh the browser. Editing the static assets in `public/` (`index.html`, `style.css`) needs only a browser refresh.

## Architecture

Single-page weather dashboard for a personal weather station. Express + TypeScript backend, TypeScript front-end (compiled to a single browser bundle), SQLite storage. The front-end has no bundler — `src/client/app.ts` compiles to `public/app.js` via `tsc`, and `public/` is otherwise served as-is with Bootstrap/Chart.js loaded from CDN.

**Data flow:** `weather_data.txt` (tab-separated, `MM/DD/YYYY` dates, 16 columns) → `import.ts` parses it → `weather.db`. The server **auto-imports on startup** and again on `POST /api/import`; both paths are idempotent via `INSERT OR REPLACE` keyed on the unique `date` column, so re-importing never duplicates. The frontend's `↻ Import` button hits that endpoint to reload after the file changes.

**SQLite via `node:sqlite`:** `db.ts` uses Node's built-in `DatabaseSync` (`import ... from 'node:sqlite'`) — **not** better-sqlite3 or any native addon. This requires **Node 22+** (dev runs Node 24). The DB file, WAL, and shm are created on first `getDb()` call. There is also a `meta` key/value table used only for `last_import` (see `getMeta`/`setMeta`).

**Layers:**
- `src/db.ts` — the only SQLite access. Periods are calendar `Window`s (`dayWindow`/`weekWindow`/`monthWindow`/`yearWindow`) read with `queryWindow`; alongside it `queryRange` and `queryYears` (the distinct years stored). Also `aggregateStats()` which computes the stat-card numbers, `coverage()`, `precipYtd()`, and the `WeatherRow` type that flows unchanged to the frontend.
- `src/server.ts` — thin Express routes over `db.ts`. Each period route turns its params into a calendar `Window` (`dayWindow`/`weekWindow`/`monthWindow`/`yearWindow` in `db.ts`) and returns `{ rows, stats, coverage }`; `coverage()` lists the window's missing days after clipping it to the first–latest stored date, so pre-station and not-yet-imported days never count as gaps. `GET /api/across-years` gathers the same day, week or month from every year (`YOY_UNITS`, each unit naming its calendar window) and returns each year's rows, stats and `days: { recorded, total }` — deliberately **not** clipped like `coverage`, so a month still under way reads as partial against its full length rather than as complete. `GET /api/precip-ytd` returns each year's running precipitation total. `GET /api/compare` is the one route that reaches the network: it fetches Open-Meteo daily data for **Baar, CH** (hardcoded `BAAR` coords) server-side to avoid browser CORS, and returns it aligned with local rows, together with Baar's **long-term daily normals** (1991–2020, `normals.ts`). Those are downloaded once from Open-Meteo's ERA5 archive (30 years of daily data in one request), reduced by `computeNormals` to one smoothed row per calendar day (±7-day circular moving average), and cached for good in the `public_normals` table; a failed download is retried at most every 10 minutes and the reply simply carries no normals meanwhile. Fetched days are **cached locally** in the `public_weather` SQLite table (`queryPublicRange`/`upsertPublic` in `db.ts`): past days are served straight from the cache, only missing or volatile (today/future forecast) days trigger a fetch, and a network failure falls back to whatever is cached. The response carries `cached`/`stale` flags.
- `src/client/app.ts` — the front-end, no framework. Holds all UI state (`period`, `allDates`, `lastRows`), builds Chart.js charts, and switches between three mutually exclusive views: `#dashboard-view`, `#compare-view` and `#yoy-view` (Across Years). Compiles to `public/app.js` (git-ignored) via `tsconfig.client.json` (DOM lib, ES2020 module, `Chart` declared as a global from the CDN).

**Two frontend conventions worth knowing:**
- `refDate()` returns the *latest date that actually has data*, not calendar today. Period selectors default to this so a fresh load lands on populated data — important because the dataset can lag real-world "today" and defaulting to `new Date()` would show an empty dashboard.
- Bootstrap dark-mode tokens (`text-muted`, `bg-secondary-subtle`) only resolve correctly because `<html>` sets `data-bs-theme="dark"`. Without it these render as dark-on-dark and become unreadable; `public/style.css` layers explicit colors on top for the stat cards and chart titles.

**External dependency:** the Compare view is the only feature that calls out to the internet (Open-Meteo). Results are cached in SQLite (see `/api/compare` above), so repeated views and offline use are served from the cache; if the fetch fails and nothing is cached for the range, it degrades gracefully to a status message.
