/* Weather dashboard front-end.
   Source of truth is this TypeScript file; it compiles to public/app.js
   (see tsconfig.client.json). Chart.js is loaded globally from a CDN. */

declare const Chart: any;

interface DateRow { date: string; }

interface WeatherRow {
  date: string;
  temp_high: number; temp_avg: number; temp_low: number;
  dew_high: number; dew_avg: number; dew_low: number;
  hum_high: number; hum_avg: number; hum_low: number;
  wind_high: number; wind_avg: number; wind_low: number;
  pres_high: number; pres_low: number; precip: number;
}

interface StatTriple { high: number; avg: number; low: number; }
interface Stats {
  temp: StatTriple;
  dew: StatTriple;
  humidity: StatTriple;
  wind: { high: number; avg: number };
  pressure: StatTriple;
  precip: { total: number; rainy_days: number };
}

interface PublicRow {
  date: string;
  temp_high: number | null;
  temp_low: number | null;
  wind_high: number | null;
  precip: number | null;
}

const CHART_DEFAULTS = {
  responsive: true,
  animation: false,
  plugins: { legend: { labels: { color: '#aaa', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#888', maxRotation: 45, font: { size: 10 } }, grid: { color: '#333' } },
    y: { ticks: { color: '#888', font: { size: 10 } }, grid: { color: '#333' } },
  },
};

// Every chart on the page, keyed by its canvas id (dashboard `chart-*` and
// compare `cmp-*` alike). Rebuilding one destroys the instance it replaces.
const charts: Record<string, any> = {};

function mkChart(id: string, type: string, data: any, extraOpts: any = {}): void {
  const ctx = document.getElementById(id);
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, { type, data, options: { ...CHART_DEFAULTS, ...extraOpts } });
}

/** A line dataset with the shared styling; `extra` overrides any of it. */
function line(label: string, data: (number | string | null)[], color: string, extra: any = {}): any {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: 'transparent',
    pointRadius: 2,
    tension: 0.3,
    ...extra,
  };
}

/** A <select> built from value/label pairs, optionally pre-selected. */
function mkSelect(
  options: { value: string; label: string }[],
  selected?: string,
  onChange?: () => void,
): HTMLSelectElement {
  const sel = document.createElement('select');
  options.forEach(o => {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    sel.appendChild(el);
  });
  if (selected !== undefined) sel.value = selected;
  if (onChange) sel.addEventListener('change', onChange);
  return sel;
}

/** Value/label pairs where both are the same string (dates, years). */
const asOptions = (values: string[]) => values.map(v => ({ value: v, label: v }));

// --- State ---
let period = 'week';
let allDates: DateRow[] = [];
let lastRows: WeatherRow[] = [];   // rows from the most recent dashboard load (drives Compare range)

// --- Nav tabs ---
document.querySelectorAll<HTMLElement>('[data-period]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll<HTMLElement>('[data-period]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    period = btn.dataset.period!;
    renderControls();
    load();
  });
});

// --- Controls ---
function renderControls(): void {
  const el = document.getElementById('controls')!;
  el.innerHTML = '';

  const dates = allDates.map(d => d.date);

  if (period === 'day') {
    el.appendChild(mkSelect(asOptions(dates), dates[dates.length - 1], load));

  } else if (period === 'week') {
    const weeks = Array.from({ length: 53 }, (_, i) => ({
      value: String(i + 1),
      label: `Week ${i + 1}`,
    }));
    el.appendChild(yearSelect());
    el.appendChild(mkSelect(weeks, String(isoWeek(refDate())), load));

  } else if (period === 'month') {
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const months = names.map((n, i) => ({ value: String(i + 1), label: n }));
    el.appendChild(yearSelect());
    el.appendChild(mkSelect(months, String(refDate().getMonth() + 1), load));

  } else if (period === 'year') {
    el.appendChild(yearSelect());

  } else if (period === 'range') {
    // Two date pickers populated ONLY from dates that exist in the data,
    // so the user can never select a window outside the recorded range.
    // From defaults to the last ~30 available days for a sensible window.
    const fromSel = mkSelect(asOptions(dates), dates[Math.max(0, dates.length - 30)], load);
    const toSel = mkSelect(asOptions(dates), dates[dates.length - 1], load);
    const fromLbl = document.createElement('span'); fromLbl.className = 'text-muted small'; fromLbl.textContent = 'From';
    const toLbl = document.createElement('span'); toLbl.className = 'text-muted small'; toLbl.textContent = 'To';

    // "All" checkbox — when checked, span the entire dataset and disable the
    // From/To pickers since the window is no longer user-controlled.
    const allWrap = document.createElement('label');
    allWrap.className = 'text-muted small d-flex align-items-center gap-1 mb-0';
    const allChk = document.createElement('input');
    allChk.type = 'checkbox';
    allChk.id = 'range-all';
    allChk.className = 'form-check-input mt-0';
    allWrap.appendChild(allChk);
    allWrap.appendChild(document.createTextNode('All'));
    allChk.addEventListener('change', () => {
      fromSel.disabled = allChk.checked;
      toSel.disabled = allChk.checked;
      load();
    });

    el.appendChild(allWrap);
    el.appendChild(fromLbl);
    el.appendChild(fromSel);
    el.appendChild(toLbl);
    el.appendChild(toSel);
  }
}

function yearSelect(): HTMLSelectElement {
  const thisYear = String(new Date().getFullYear());
  const years = [...new Set(allDates.map(d => d.date.slice(0, 4)))];
  return mkSelect(
    asOptions(years.length ? years : [thisYear]),
    years[years.length - 1] || thisYear,
    load,
  );
}

// Reference date = latest date that actually has data (falls back to today
// when no data is loaded). Selectors default to this period so a fresh load
// lands on populated data rather than the empty calendar-current period.
function refDate(): Date {
  if (allDates.length) {
    const [y, m, d] = allDates[allDates.length - 1].date.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

function isoWeek(d: Date): number {
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const diff = d.getTime() - jan4.getTime();
  return Math.ceil((diff / 86400000 + (jan4.getDay() || 7)) / 7);
}

// --- Load data ---
async function load(): Promise<void> {
  const el = document.getElementById('controls')!;
  const sels = el.querySelectorAll('select');
  let url: string;

  if (period === 'day') {
    url = `/api/day?date=${sels[0]?.value ?? ''}`;
  } else if (period === 'week') {
    url = `/api/week?year=${sels[0]?.value}&week=${sels[1]?.value}`;
  } else if (period === 'month') {
    url = `/api/month?year=${sels[0]?.value}&month=${sels[1]?.value}`;
  } else if (period === 'range') {
    let from: string | undefined, to: string | undefined;
    if ((document.getElementById('range-all') as HTMLInputElement | null)?.checked && allDates.length) {
      from = allDates[0].date;                       // whole dataset
      to = allDates[allDates.length - 1].date;
    } else {
      from = sels[0]?.value; to = sels[1]?.value;
      if (from && to && from > to) [from, to] = [to, from]; // tolerate reversed picks
    }
    url = `/api/range?from=${from}&to=${to}`;
  } else {
    url = `/api/year?year=${sels[0]?.value}`;
  }

  const resp = await fetch(url);
  if (!resp.ok) { lastRows = []; clearAll(); return; }
  const { rows, stats } = await resp.json() as { rows: WeatherRow[]; stats: Stats };

  lastRows = rows;
  renderStats(stats);
  renderCharts(rows);
  renderTable(rows);
}

// --- Data freshness (last import time) ---
async function refreshStatus(): Promise<void> {
  try {
    const r = await fetch('/api/status');
    const { last_import, records } = await r.json() as { last_import: string | null; records: number };
    const el = document.getElementById('last-import')!;
    if (last_import) {
      const when = new Date(last_import);
      el.textContent = `Imported ${when.toLocaleString()} · ${records} records`;
      el.title = `Last import: ${when.toString()}`;
    } else {
      el.textContent = 'Not yet imported';
    }
  } catch { /* non-critical */ }
}

// --- Stats cards ---
function renderStats(s: Stats | undefined): void {
  if (!s) return;
  setText('s-temp-avg',    `${s.temp.avg} °C`);
  setText('s-temp-high',   `${s.temp.high} °C`);
  setText('s-temp-low',    `${s.temp.low} °C`);
  setText('s-hum-avg',     `${s.humidity.avg} %`);
  setText('s-hum-high',    `${s.humidity.high} %`);
  setText('s-hum-low',     `${s.humidity.low} %`);
  setText('s-wind-high',   `${s.wind.high} km/h`);
  setText('s-wind-avg',    `${s.wind.avg} km/h`);
  setText('s-pres-avg',    `${s.pressure.avg} hPa`);
  setText('s-pres-high',   `${s.pressure.high} hPa`);
  setText('s-pres-low',    `${s.pressure.low} hPa`);
  setText('s-precip-total',`${s.precip.total} mm`);
  setText('s-precip-rainy',s.precip.rainy_days);
  setText('s-dew-avg',     `${s.dew.avg} °C`);
  setText('s-dew-high',    `${s.dew.high} °C`);
  setText('s-dew-low',     `${s.dew.low} °C`);
}

function setText(id: string, val: string | number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val);
}

// --- Chart visibility ---
// Each dashboard chart can be toggled on/off. Hiding one removes its whole
// grid column so the remaining charts reflow to fill the row. The choice is
// persisted in localStorage so it survives reloads.
const CHART_META: { key: string; label: string }[] = [
  { key: 'temp',   label: 'Temperature' },
  { key: 'precip', label: 'Precipitation' },
  { key: 'hum',    label: 'Humidity' },
  { key: 'pres',   label: 'Pressure' },
  { key: 'wind',   label: 'Wind' },
];

function loadChartVisibility(): Record<string, boolean> {
  const vis: Record<string, boolean> = {};
  let saved: Record<string, boolean> = {};
  try { saved = JSON.parse(localStorage.getItem('chartVisibility') || '{}'); } catch { /* ignore */ }
  CHART_META.forEach(c => { vis[c.key] = saved[c.key] !== false; }); // default visible
  return vis;
}

let chartVisibility: Record<string, boolean> = loadChartVisibility();

function applyChartVisibility(): void {
  CHART_META.forEach(c => {
    const col = document.querySelector<HTMLElement>(`[data-chart="${c.key}"]`);
    if (col) col.classList.toggle('d-none', !chartVisibility[c.key]);
  });
  // Charts that just became visible were sized to a hidden (0-width) canvas;
  // nudge Chart.js to re-measure now that the column has real dimensions.
  CHART_META.forEach(c => {
    if (chartVisibility[c.key]) charts[`chart-${c.key}`]?.resize();
  });
}

function renderChartToggles(): void {
  const el = document.getElementById('chart-toggles');
  if (!el) return;
  el.innerHTML = '';
  CHART_META.forEach(c => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-outline-secondary';
    btn.textContent = c.label;
    const sync = () => {
      btn.classList.toggle('active', chartVisibility[c.key]);
      btn.setAttribute('aria-pressed', String(chartVisibility[c.key]));
    };
    sync();
    btn.addEventListener('click', () => {
      chartVisibility[c.key] = !chartVisibility[c.key];
      sync();
      try { localStorage.setItem('chartVisibility', JSON.stringify(chartVisibility)); } catch { /* ignore */ }
      applyChartVisibility();
    });
    el.appendChild(btn);
  });
}

// --- Charts ---
function labels(rows: WeatherRow[]): string[] {
  return rows.map(r => r.date.slice(5)); // MM-DD
}

function renderCharts(rows: WeatherRow[]): void {
  const lbl = labels(rows);

  mkChart('chart-temp', 'line', {
    labels: lbl,
    datasets: [
      line('High', rows.map(r => r.temp_high), '#f87272'),
      line('Avg',  rows.map(r => r.temp_avg),  '#facc15'),
      line('Low',  rows.map(r => r.temp_low),  '#60a5fa'),
      line('Dew',  rows.map(r => r.dew_avg),   '#4ade80', { borderDash: [4, 3] }),
    ],
  });

  mkChart('chart-precip', 'bar', {
    labels: lbl,
    datasets: [
      { label: 'Precip', data: rows.map(r => r.precip), backgroundColor: '#60a5fa99' },
    ],
  });

  mkChart('chart-hum', 'line', {
    labels: lbl,
    datasets: [
      line('High', rows.map(r => r.hum_high), '#f87272', { backgroundColor: '#f8727211', fill: true }),
      line('Avg',  rows.map(r => r.hum_avg),  '#facc15'),
      line('Low',  rows.map(r => r.hum_low),  '#60a5fa', { backgroundColor: '#60a5fa11', fill: true }),
    ],
  }, { scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 } } });

  mkChart('chart-pres', 'line', {
    labels: lbl,
    datasets: [
      line('High', rows.map(r => r.pres_high), '#a78bfa'),
      line('Low',  rows.map(r => r.pres_low),  '#818cf8', { backgroundColor: '#818cf811', fill: true }),
    ],
  });

  mkChart('chart-wind', 'line', {
    labels: lbl,
    datasets: [
      line('High', rows.map(r => r.wind_high), '#fb923c', { backgroundColor: '#fb923c11', fill: true }),
      line('Avg',  rows.map(r => r.wind_avg),  '#fdba74'),
    ],
  });

  applyChartVisibility();
}

// --- Table ---
function renderTable(rows: WeatherRow[]): void {
  const tbody = document.getElementById('table-body')!;
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.date}</td>
      <td class="text-danger">${r.temp_high}</td>
      <td>${r.temp_avg}</td>
      <td class="text-info">${r.temp_low}</td>
      <td class="text-danger">${r.hum_high}%</td>
      <td>${r.hum_avg}%</td>
      <td class="text-info">${r.hum_low}%</td>
      <td class="text-warning">${r.wind_high}</td>
      <td>${r.wind_avg}</td>
      <td>${r.pres_high}</td>
      <td>${r.pres_low}</td>
      <td class="${r.precip > 0 ? 'text-primary' : ''}">${r.precip}</td>
    </tr>
  `).join('');
}

function clearAll(): void {
  CHART_META.forEach(({ key }) => {
    const id = `chart-${key}`;
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  });
  document.getElementById('table-body')!.innerHTML = '';
}

// --- Import button ---
const importBtn = document.getElementById('btn-import') as HTMLButtonElement;
importBtn.addEventListener('click', async () => {
  importBtn.textContent = '…';
  importBtn.disabled = true;
  try {
    const r = await fetch('/api/import', { method: 'POST' });
    const j = await r.json() as { total: number; inserted: number; updated: number; unchanged: number };
    // Report what actually changed, not just the row count in the file.
    importBtn.textContent = `✓ ${j.inserted} new · ${j.updated} upd`;
    importBtn.title = `${j.total} rows processed — ${j.inserted} new, ${j.updated} updated, ${j.unchanged} unchanged`;
    // refresh dates and reload
    const resp = await fetch('/api/dates');
    allDates = await resp.json() as DateRow[];
    renderControls();
    await load();
    await refreshStatus();
  } catch (e) {
    importBtn.textContent = '✗ Error';
  } finally {
    setTimeout(() => { importBtn.textContent = '↻ Import'; importBtn.disabled = false; }, 2000);
  }
});

// --- Compare vs public service (Baar) ---
let compareOn = false;

const compareBtn = document.getElementById('btn-compare')!;
compareBtn.addEventListener('click', () => {
  compareOn = !compareOn;
  document.getElementById('dashboard-view')!.classList.toggle('d-none', compareOn);
  document.getElementById('compare-view')!.classList.toggle('d-none', !compareOn);
  compareBtn.classList.toggle('active', compareOn);
  if (compareOn) loadCompare();
});

async function loadCompare(): Promise<void> {
  const status = document.getElementById('cmp-status')!;
  if (!lastRows.length) {
    status.textContent = 'No local data selected — pick a period on the dashboard first.';
    return;
  }
  const from = lastRows[0].date;
  const to = lastRows[lastRows.length - 1].date;
  document.getElementById('cmp-range')!.textContent = `${from} → ${to}`;
  status.textContent = 'Loading public data…';

  let data: { location: string; source: string; mine: WeatherRow[]; public: PublicRow[] };
  try {
    const r = await fetch(`/api/compare?from=${from}&to=${to}`);
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    data = await r.json();
  } catch (e) {
    status.textContent = `Could not fetch public data: ${(e as Error).message}`;
    return;
  }
  status.textContent = '';

  // Align public rows to my dates so both series share the same x-axis.
  const pub = new Map<string, PublicRow>(data.public.map(p => [p.date, p]));
  const lbl = labels(lastRows);
  const mineOf = (key: keyof WeatherRow) => lastRows.map(r => r[key]);
  const pubOf  = (key: keyof PublicRow) => lastRows.map(r => pub.get(r.date)?.[key] ?? null);

  const pair = (label: string, mineKey: keyof WeatherRow, pubKey: keyof PublicRow) => ({
    labels: lbl,
    datasets: [
      line(`Me · ${label}`,   mineOf(mineKey), '#38bdf8'),
      line(`Baar · ${label}`, pubOf(pubKey),  '#fb923c', { borderDash: [5, 3] }),
    ],
  });

  mkChart('cmp-temp-high', 'line', pair('High', 'temp_high', 'temp_high'));
  mkChart('cmp-temp-low',  'line', pair('Low',  'temp_low',  'temp_low'));
  mkChart('cmp-wind',      'line', pair('Wind', 'wind_high', 'wind_high'));
  mkChart('cmp-precip', 'bar', {
    labels: lbl,
    datasets: [
      { label: 'Me',   data: mineOf('precip'), backgroundColor: '#38bdf899' },
      { label: 'Baar', data: pubOf('precip'),  backgroundColor: '#fb923c99' },
    ],
  });

  renderCompareSummary(pub);
}

function renderCompareSummary(pub: Map<string, PublicRow>): void {
  const avg = (vals: (number | null)[]): number | null => {
    const v = vals.filter((x): x is number => x != null && !Number.isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const rows: [string, keyof WeatherRow & keyof PublicRow][] = [
    ['Temp High (°C)', 'temp_high'],
    ['Temp Low (°C)',  'temp_low'],
    ['Wind Max (km/h)','wind_high'],
    ['Precip (mm)',    'precip'],
  ];
  const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(1));

  document.getElementById('cmp-summary-body')!.innerHTML = rows.map(([name, key]) => {
    const mine = avg(lastRows.map(r => r[key] as number));
    const theirs = avg(lastRows.map(r => (pub.get(r.date)?.[key] ?? null) as number | null));
    const diff = (mine != null && theirs != null) ? mine - theirs : null;
    const diffCls = diff == null ? '' : diff > 0 ? 'text-danger' : diff < 0 ? 'text-info' : '';
    const diffTxt = diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}`;
    return `<tr><td>${name}</td><td>${fmt(mine)}</td><td>${fmt(theirs)}</td><td class="${diffCls}">${diffTxt}</td></tr>`;
  }).join('');
}

// --- Init ---
(async () => {
  const resp = await fetch('/api/dates');
  allDates = await resp.json() as DateRow[];
  renderChartToggles();
  applyChartVisibility();   // apply persisted hidden state immediately, even before charts render
  renderControls();
  await load();
  await refreshStatus();
})();
