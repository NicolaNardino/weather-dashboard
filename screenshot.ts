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
  }

  const res = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  if (!res || !res.ok()) failures.push(`GET ${BASE_URL} → ${res ? res.status() : 'no response'}`);

  await capture('day', 'dashboard.png');
  await capture('month', 'dashboard-month.png', '[data-period="month"]');
  await capture('year', 'dashboard-year.png', '[data-period="year"]');

  await browser.close();

  if (errors.length) {
    console.error(`Console errors (${errors.length}):`);
    for (const e of errors) console.error(`  ${e}`);
  } else {
    console.log('No console errors');
  }
  if (failures.length) {
    console.error(`Failures (${failures.length}):`);
    for (const f of failures) console.error(`  ${f}`);
  }

  if (errors.length || failures.length) process.exit(1);
  console.log('Dashboard verified: all periods rendered with populated stats.');
})();
