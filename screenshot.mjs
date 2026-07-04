import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const errors = [];
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
