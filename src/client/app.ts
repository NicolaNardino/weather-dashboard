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

/** The measures both my rows and the public ones carry — the Compare axis. */
type SharedKey = Exclude<keyof WeatherRow & keyof PublicRow, 'date'>;

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

/** Tear down the chart on `id`, if any — Chart.js leaks the canvas otherwise. */
function destroyChart(id: string): void {
  charts[id]?.destroy();
  delete charts[id];
}

function mkChart(id: string, type: string, data: any, extraOpts: any = {}): void {
  const ctx = document.getElementById(id);
  destroyChart(id);
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

/** createElement + property assignment + children, in one expression. */
function mkEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  children.forEach(c => node.append(c));
  return node;
}

/** A <select> built from value/label pairs, optionally pre-selected. */
function mkSelect(
  options: { value: string; label: string }[],
  selected?: string,
  onChange?: () => void,
): HTMLSelectElement {
  const sel = mkEl(
    'select',
    {},
    options.map(o => mkEl('option', { value: o.value, textContent: o.label })),
  );
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
    const label = (text: string) => mkEl('span', { className: 'text-muted small', textContent: text });

    // "All" checkbox — when checked, span the entire dataset and disable the
    // From/To pickers since the window is no longer user-controlled.
    const allChk = mkEl('input', { type: 'checkbox', id: 'range-all', className: 'form-check-input mt-0' });
    const allWrap = mkEl(
      'label',
      { className: 'text-muted small d-flex align-items-center gap-1 mb-0' },
      [allChk, 'All'],
    );
    allChk.addEventListener('change', () => {
      fromSel.disabled = allChk.checked;
      toSel.disabled = allChk.checked;
      load();
    });

    el.append(allWrap, label('From'), fromSel, label('To'), toSel);
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

/**
 * Re-read the available dates, then rebuild the controls and everything they
 * drive. The startup path and the Import button both need exactly this, and
 * both used to spell it out — so a step added to one could go missing in the
 * other.
 */
async function reloadDates(): Promise<void> {
  const resp = await fetch('/api/dates');
  allDates = await resp.json() as DateRow[];
  renderControls();
  await load();
  await refreshStatus();
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
// Each measure fills the cards `s-<prefix>-<high|avg|low>` from the like-named
// keys of its stats group, so the card ids and the API shape line up by
// construction instead of through sixteen hand-written pairings.
const STAT_GROUPS: { prefix: string; pick: (s: Stats) => Record<string, number>; unit: string }[] = [
  { prefix: 'temp',  pick: s => s.temp,     unit: '°C' },
  { prefix: 'hum',   pick: s => s.humidity, unit: '%' },
  { prefix: 'wind',  pick: s => s.wind,     unit: 'km/h' },
  { prefix: 'pres',  pick: s => s.pressure, unit: 'hPa' },
  { prefix: 'dew',   pick: s => s.dew,      unit: '°C' },
];

function renderStats(s: Stats | undefined): void {
  if (!s) return;
  for (const { prefix, pick, unit } of STAT_GROUPS) {
    for (const [key, value] of Object.entries(pick(s))) {
      setText(`s-${prefix}-${key}`, `${value} ${unit}`);
    }
  }
  // Precipitation is the odd one out: a total and a day count, not high/avg/low.
  setText('s-precip-total', `${s.precip.total} mm`);
  setText('s-precip-rainy', s.precip.rainy_days);
}

function setText(id: string, val: string | number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val);
}

// --- The dashboard charts ---
// One entry per chart: its canvas (`chart-<key>`), its toggle-button label, and
// how to turn a period's rows into datasets. Both the toggles and the rendering
// walk this list, so a chart can't end up drawn but untoggleable (or vice
// versa). Each can be toggled off, which removes its whole grid column so the
// rest reflow to fill the row; the choice persists in localStorage.
interface ChartSpec {
  key: string;
  label: string;
  type: string;
  datasets: (rows: WeatherRow[]) => any[];
  /** Chart-specific option overrides merged over CHART_DEFAULTS. */
  opts?: any;
}

const CHART_META: ChartSpec[] = [
  {
    key: 'temp', label: 'Temperature', type: 'line',
    datasets: rows => [
      line('High', rows.map(r => r.temp_high), '#f87272'),
      line('Avg',  rows.map(r => r.temp_avg),  '#facc15'),
      line('Low',  rows.map(r => r.temp_low),  '#60a5fa'),
      line('Dew',  rows.map(r => r.dew_avg),   '#4ade80', { borderDash: [4, 3] }),
    ],
  },
  {
    key: 'precip', label: 'Precipitation', type: 'bar',
    datasets: rows => [
      { label: 'Precip', data: rows.map(r => r.precip), backgroundColor: '#60a5fa99' },
    ],
  },
  {
    key: 'hum', label: 'Humidity', type: 'line',
    datasets: rows => [
      line('High', rows.map(r => r.hum_high), '#f87272', { backgroundColor: '#f8727211', fill: true }),
      line('Avg',  rows.map(r => r.hum_avg),  '#facc15'),
      line('Low',  rows.map(r => r.hum_low),  '#60a5fa', { backgroundColor: '#60a5fa11', fill: true }),
    ],
    // Humidity is a percentage, so pin the axis rather than letting it autoscale.
    opts: { scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 } } },
  },
  {
    key: 'pres', label: 'Pressure', type: 'line',
    datasets: rows => [
      line('High', rows.map(r => r.pres_high), '#a78bfa'),
      line('Low',  rows.map(r => r.pres_low),  '#818cf8', { backgroundColor: '#818cf811', fill: true }),
    ],
  },
  {
    key: 'wind', label: 'Wind', type: 'line',
    datasets: rows => [
      line('High', rows.map(r => r.wind_high), '#fb923c', { backgroundColor: '#fb923c11', fill: true }),
      line('Avg',  rows.map(r => r.wind_avg),  '#fdba74'),
    ],
  },
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
    const visible = chartVisibility[c.key];
    document.querySelector<HTMLElement>(`[data-chart="${c.key}"]`)?.classList.toggle('d-none', !visible);
    // A chart that just became visible was sized to a hidden (0-width) canvas;
    // nudge Chart.js to re-measure now that the column has real dimensions.
    if (visible) charts[`chart-${c.key}`]?.resize();
  });
}

function renderChartToggles(): void {
  const el = document.getElementById('chart-toggles');
  if (!el) return;
  el.innerHTML = '';
  CHART_META.forEach(c => {
    const btn = mkEl('button', { type: 'button', className: 'btn btn-outline-secondary', textContent: c.label });
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
  for (const c of CHART_META) {
    mkChart(`chart-${c.key}`, c.type, { labels: lbl, datasets: c.datasets(rows) }, c.opts);
  }
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
  CHART_META.forEach(({ key }) => destroyChart(`chart-${key}`));
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
    await reloadDates();
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
  const mineOf = (key: SharedKey) => lastRows.map(r => r[key] as number);
  const pubOf  = (key: SharedKey) => lastRows.map(r => (pub.get(r.date)?.[key] ?? null) as number | null);

  const pair = (label: string, key: SharedKey) => ({
    labels: lbl,
    datasets: [
      line(`Me · ${label}`,   mineOf(key), '#38bdf8'),
      line(`Baar · ${label}`, pubOf(key),  '#fb923c', { borderDash: [5, 3] }),
    ],
  });

  mkChart('cmp-temp-high', 'line', pair('High', 'temp_high'));
  mkChart('cmp-temp-low',  'line', pair('Low',  'temp_low'));
  mkChart('cmp-wind',      'line', pair('Wind', 'wind_high'));
  mkChart('cmp-precip', 'bar', {
    labels: lbl,
    datasets: [
      { label: 'Me',   data: mineOf('precip'), backgroundColor: '#38bdf899' },
      { label: 'Baar', data: pubOf('precip'),  backgroundColor: '#fb923c99' },
    ],
  });

  renderCompareSummary(mineOf, pubOf);
}

function renderCompareSummary(
  mineOf: (key: SharedKey) => number[],
  pubOf: (key: SharedKey) => (number | null)[],
): void {
  const avg = (vals: (number | null)[]): number | null => {
    const v = vals.filter((x): x is number => x != null && !Number.isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const rows: [string, SharedKey][] = [
    ['Temp High (°C)', 'temp_high'],
    ['Temp Low (°C)',  'temp_low'],
    ['Wind Max (km/h)','wind_high'],
    ['Precip (mm)',    'precip'],
  ];
  const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(1));

  document.getElementById('cmp-summary-body')!.innerHTML = rows.map(([name, key]) => {
    const mine = avg(mineOf(key));
    const theirs = avg(pubOf(key));
    const diff = (mine != null && theirs != null) ? mine - theirs : null;
    const diffCls = diff == null ? '' : diff > 0 ? 'text-danger' : diff < 0 ? 'text-info' : '';
    const diffTxt = diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}`;
    return `<tr><td>${name}</td><td>${fmt(mine)}</td><td>${fmt(theirs)}</td><td class="${diffCls}">${diffTxt}</td></tr>`;
  }).join('');
}

// --- Init ---
(async () => {
  renderChartToggles();
  applyChartVisibility();   // apply persisted hidden state immediately, even before charts render
  await reloadDates();
})();
