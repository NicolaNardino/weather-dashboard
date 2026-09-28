import { chromium } from 'playwright';
import path from 'path';

// De-facto verification harness: drives the running server, asserts the
// charts populate, and captures dashboard screenshots. Run against a live
// server (npm run dev) via `npm run screenshot`.
//
// This EXITS NON-ZERO when anything is wrong — a page-load failure, a stat card
// that never fills in, or any console error. That matters because CI runs it as
// the end-to-end gate: a harness that only logged its problems would report a
// green build for a broken dashboard.
//
// Set PLAYWRIGHT_CHROMIUM_PATH to use a preinstalled browser instead of the one
// `npx playwright install chromium` downloads (useful in sandboxes with no
// access to Playwright's CDN).

const BASE_URL = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_PATH;

/** The stat card that stays '—' until a period's data has rendered. */
const STAT_READY = () => document.getElementById('s-temp-avg')?.textContent !== '—';

(async () => {
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
  });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(`uncaught: ${e.message}`));
  page.on('requestfailed', r => {
    // A failed request to our own server is a real fault; third-party CDN
    // hiccups (Bootstrap/Chart.js) are noise we don't want failing the build.
    if (r.url().startsWith(BASE_URL)) errors.push(`request failed: ${r.url()}`);
  });

  const failures: string[] = [];

  /** Render one period, screenshot it, and check the stats actually filled in. */
  async function capture(label: string, file: string, click?: string): Promise<void> {
    try {
      if (click) await page.click(click);
      await page.waitForFunction(STAT_READY, undefined, { timeout: 15000 });
      await page.screenshot({ path: path.join(__dirname, file) });
      console.log(`Screenshot: ${file}`);
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // The stat cards are the cheapest proof the data actually reached the page.
    const stats = await page.$$eval('[id^="s-"]', els =>
      els.map(el => ({ id: el.id, text: (el.textContent ?? '').trim() })),
    );
    const empty = stats.filter(s => s.text === '' || s.text === '—');
    if (stats.length === 0) failures.push(`${label}: no stat cards found`);
    if (empty.length) {
      failures.push(`${label}: ${empty.length} stat card(s) still empty: ${empty.map(s => s.id).join(', ')}`);
    }

    // The missing-day indicator is set on every load, gaps or not.
    const coverage = ((await page.textContent('#coverage')) ?? '').trim();
    if (!coverage) failures.push(`${label}: missing-day indicator is empty`);
    else console.log(`  ${label} coverage: ${coverage}`);
  }

  const res = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  if (!res || !res.ok()) failures.push(`GET ${BASE_URL} → ${res ? res.status() : 'no response'}`);

  await capture('day', 'dashboard.png');
  await capture('month', 'dashboard-month.png', '[data-period="month"]');
  await capture('year', 'dashboard-year.png', '[data-period="year"]');

  // The Year period spans many months, so it must also draw the calendar heatmap.
  const calDays = await page.$$eval('#calendar .cal-day[data-date]', els => els.length);
  if (!calDays) failures.push('year: calendar heatmap drew no days');

  // Across Years: the year-to-date rain chart fills its "As of …" note once drawn.
  try {
    await page.click('#btn-yoy');
    await page.waitForFunction(
      () => (document.getElementById('ytd-note')?.textContent ?? '').startsWith('As of'),
      undefined, { timeout: 15000 },
    );
    // Each year's column in the comparison table says how many of the period's
    // days its figures cover ("18/31 days"), so a partial period can't pass
    // for a complete one.
    await page.waitForFunction(
      () => /\d+\/\d+ days?/.test(document.getElementById('yoy-table-head')?.textContent ?? ''),
      undefined, { timeout: 15000 },
    );
    await page.screenshot({ path: path.join(__dirname, 'dashboard-yoy.png'), fullPage: true });
    console.log('Screenshot: dashboard-yoy.png');
  } catch (e) {
    failures.push(`across years: ${e instanceof Error ? e.message : String(e)}`);
  }

  await browser.close();

  /** Print a labelled group of problems, one per line. */
  const report = (label: string, items: string[]) => {
    if (!items.length) return;
    console.error(`${label} (${items.length}):`);
    for (const item of items) console.error(`  ${item}`);
  };

  if (!errors.length) console.log('No console errors');
  report('Console errors', errors);
  report('Failures', failures);

  if (errors.length || failures.length) process.exit(1);
  console.log('Dashboard verified: all periods rendered with populated stats.');
})();
