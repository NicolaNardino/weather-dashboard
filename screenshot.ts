import { chromium } from 'playwright';
import path from 'path';

// De-facto verification harness: drives the running server, asserts the
// charts populate, and captures dashboard screenshots. Run against a live
// server (npm run dev) via `npm run screenshot`.
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://localhost:3000');
  // wait for charts to render
  await page.waitForFunction(() => document.getElementById('s-temp-avg')?.textContent !== '—');

  await page.screenshot({ path: path.join(__dirname, 'dashboard.png') });
  console.log('Screenshot: dashboard.png');

  // Switch to Month view and screenshot
  await page.click('[data-period="month"]');
  await page.waitForFunction(() => document.getElementById('s-temp-avg')?.textContent !== '—');
  await page.screenshot({ path: path.join(__dirname, 'dashboard-month.png') });
  console.log('Screenshot: dashboard-month.png');

  // Switch to Year view
  await page.click('[data-period="year"]');
  await page.waitForFunction(() => document.getElementById('s-temp-avg')?.textContent !== '—');
  await page.screenshot({ path: path.join(__dirname, 'dashboard-year.png') });
  console.log('Screenshot: dashboard-year.png');

  if (errors.length) console.error('Console errors:', errors);
  else console.log('No console errors');

  await browser.close();
})();
