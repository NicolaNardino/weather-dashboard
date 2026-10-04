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

/** How long any one page condition gets to come true, written out at each wait. */
const WAIT_MS = 15000;

/**
 * A caught value as the text to report it by. Both failure paths below — the
 * period capture and the Across-Years block — spelled the same
 * `instanceof Error` ternary out, so "what went wrong" had two spellings.
 */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

  /**
   * Run one checked step, recording a thrown timeout against its label instead
   * of aborting the run — so a broken Across-Years view still lets the period
   * captures report, and vice versa. Both halves of this harness wrapped their
   * waits in the same try/catch/push, and only one of them was a function.
   *
   * It reports whether the step got through, because what follows a capture —
   * reading the stat cards back — is only worth doing if the page rendered.
   */
  async function step(label: string, body: () => Promise<void>): Promise<boolean> {
    try {
      await body();
      return true;
    } catch (e) {
      failures.push(`${label}: ${errText(e)}`);
      return false;
    }
  }

  /** Wait for a page condition, under the one timeout every wait here shares. */
  const waitFor = (fn: () => boolean) =>
    page.waitForFunction(fn, undefined, { timeout: WAIT_MS });

  /**
   * Capture a screenshot into the repo root and say so. Both the period shots
   * and the Across-Years one write a file beside this script and log the same
   * line about it, and each spelled out its own `path.join(__dirname, …)`.
   */
  async function shot(file: string, fullPage = false): Promise<void> {
    await page.screenshot({ path: path.join(__dirname, file), fullPage });
    console.log(`Screenshot: ${file}`);
  }

  /** Render one period, screenshot it, and check the stats actually filled in. */
  async function capture(label: string, file: string, click?: string): Promise<void> {
    const rendered = await step(label, async () => {
      if (click) await page.click(click);
      await waitFor(STAT_READY);
      await shot(file);
    });
    if (!rendered) return;

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
  await step('across years', async () => {
    await page.click('#btn-yoy');
    await waitFor(() => (document.getElementById('ytd-note')?.textContent ?? '').startsWith('As of'));
    // Each year's column in the comparison table says how many of the period's
    // days its figures cover ("18/31 days"), so a partial period can't pass
    // for a complete one.
    await waitFor(() =>
      /\d+\/\d+ days?/.test(document.getElementById('yoy-table-head')?.textContent ?? ''));
    await shot('dashboard-yoy.png', true);
  });

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
