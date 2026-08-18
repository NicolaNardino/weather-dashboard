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

/** Interfaces get no implicit index signature, so this is a type alias — the
    stat cards read their group as a Record<string, number>. */
type StatTriple = { high: number; avg: number; low: number };
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

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * One entry per period selector. `controls` populates the header with that
 * period's pickers; `url` turns whatever those pickers now hold into the API
 * call. Keeping the pair together means the `period` string is dispatched once
 * rather than in two `if/else` chains that had to stay in step — a new period
 * is one entry, not two branches in two places.
 */
interface PeriodSpec {
  /** Text on this period's nav tab. */
  label: string;
  controls: (el: HTMLElement, dates: string[]) => void;
  url: (sels: HTMLSelectElement[]) => string;
}

const PERIODS = {
  day: {
    label: 'Day',
    controls: (el, dates) => el.append(mkSelect(asOptions(dates), dates[dates.length - 1], load)),
    url: s => `/api/day?date=${s[0]?.value ?? ''}`,
  },

  week: {
    label: 'Week',
    controls: el => {
      const weeks = Array.from({ length: 53 }, (_, i) => ({
        value: String(i + 1),
        label: `Week ${i + 1}`,
      }));
      el.append(yearSelect(), mkSelect(weeks, String(isoWeek(refDate())), load));
    },
    url: s => `/api/week?year=${s[0]?.value}&week=${s[1]?.value}`,
  },

  month: {
    label: 'Month',
    controls: el => {
      const months = MONTH_NAMES.map((n, i) => ({ value: String(i + 1), label: n }));
      el.append(yearSelect(), mkSelect(months, String(refDate().getMonth() + 1), load));
    },
    url: s => `/api/month?year=${s[0]?.value}&month=${s[1]?.value}`,
  },

  year: {
    label: 'Year',
    controls: el => el.append(yearSelect()),
    url: s => `/api/year?year=${s[0]?.value}`,
  },

  range: {
    label: 'Range',
    // Two date pickers populated ONLY from dates that exist in the data,
    // so the user can never select a window outside the recorded range.
    // From defaults to the last ~30 available days for a sensible window.
    controls: (el, dates) => {
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
    },
    url: s => {
      let from: string | undefined, to: string | undefined;
      if ((document.getElementById('range-all') as HTMLInputElement | null)?.checked && allDates.length) {
        from = allDates[0].date;                       // whole dataset
        to = allDates[allDates.length - 1].date;
      } else {
        from = s[0]?.value; to = s[1]?.value;
        if (from && to && from > to) [from, to] = [to, from]; // tolerate reversed picks
      }
      return `/api/range?from=${from}&to=${to}`;
    },
  },
} satisfies Record<string, PeriodSpec>;

type Period = keyof typeof PERIODS;

// --- State ---
let period: Period = 'week';
let allDates: DateRow[] = [];
let lastRows: WeatherRow[] = [];   // rows from the most recent dashboard load (drives Compare range)

// --- Nav tabs ---
// Built from PERIODS, like every other list on the page. The tabs used to be
// hand-written in index.html — a fifth copy of the period names that could
// offer a period the dashboard didn't implement, which the click handler had
// to guard against.
function renderPeriodTabs(): void {
  const el = document.getElementById('period-tabs')!;
  el.innerHTML = '';
  for (const key of Object.keys(PERIODS) as Period[]) {
    const btn = mkEl('button', {
      type: 'button',
      className: `btn btn-outline-secondary${key === period ? ' active' : ''}`,
      textContent: PERIODS[key].label,
    });
    btn.dataset.period = key;   // the verification harness clicks these
    btn.addEventListener('click', () => {
      period = key;
      renderPeriodTabs();       // re-render to move the active class
      renderControls();
      load();
    });
    el.append(btn);
  }
}

// --- Controls ---
function renderControls(): void {
  const el = document.getElementById('controls')!;
  el.innerHTML = '';
  PERIODS[period].controls(el, allDates.map(d => d.date));
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
  const sels = Array.from(document.getElementById('controls')!.querySelectorAll('select'));
  const resp = await fetch(PERIODS[period].url(sels));
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
// One entry per card, driving both its markup and its values. The six cards
// used to be hand-written in index.html, each repeating the same ten lines of
// Bootstrap and naming ids that a second list here had to match — so a card
// added in one place was invisible (or blank) until the other agreed.
interface StatCard {
  /** Values render into `s-<prefix>-<key>`, matching this card's stats group. */
  prefix: string;
  title: string;
  /** The group of `stats` this card reads. */
  pick: (s: Stats) => Record<string, number>;
  /** Appended to every value except those listed in `bare`. */
  unit: string;
  /** The key shown as the card's big number. */
  headline: string;
  /** The small line under it: value keys with any literal text around them. */
  sub: { key: string; before?: string; after?: string }[];
  /** Keys that are counts, not measurements, so they carry no unit. */
  bare?: string[];
}

const HIGH_LOW: StatCard['sub'] = [{ key: 'low', after: ' / ' }, { key: 'high' }];

const STAT_CARDS: StatCard[] = [
  { prefix: 'temp', title: 'Temperature', pick: s => s.temp, unit: '°C',
    headline: 'avg', sub: HIGH_LOW },
  { prefix: 'hum', title: 'Humidity', pick: s => s.humidity, unit: '%',
    headline: 'avg', sub: HIGH_LOW },
  { prefix: 'wind', title: 'Wind (max)', pick: s => s.wind, unit: 'km/h',
    headline: 'high', sub: [{ key: 'avg', before: 'avg ' }] },
  { prefix: 'pres', title: 'Pressure', pick: s => s.pressure, unit: 'hPa',
    headline: 'avg', sub: HIGH_LOW },
  { prefix: 'precip', title: 'Precipitation', pick: s => s.precip, unit: 'mm',
    headline: 'total', sub: [{ key: 'rainy_days', after: ' rainy days' }], bare: ['rainy_days'] },
  { prefix: 'dew', title: 'Dew Point', pick: s => s.dew, unit: '°C',
    headline: 'avg', sub: HIGH_LOW },
];

const statSpan = (prefix: string, key: string) => `<span id="s-${prefix}-${key}">—</span>`;

function renderStatCards(): void {
  document.getElementById('stat-cards')!.innerHTML = STAT_CARDS.map(c => `
    <div class="col-6 col-md-4 col-xl-2">
      <div class="card bg-secondary-subtle border-0 h-100">
        <div class="card-body p-3">
          <div class="text-muted small">${c.title}</div>
          <div class="fs-4 fw-bold" id="s-${c.prefix}-${c.headline}">—</div>
          <div class="small text-muted">${c.sub
            .map(p => `${p.before ?? ''}${statSpan(c.prefix, p.key)}${p.after ?? ''}`)
            .join('')}</div>
        </div>
      </div>
    </div>`).join('');
}

function renderStats(s: Stats | undefined): void {
  if (!s) return;
  for (const c of STAT_CARDS) {
    for (const [key, value] of Object.entries(c.pick(s))) {
      // A group can carry keys no card shows (precip.max); setText ignores those.
      setText(`s-${c.prefix}-${key}`, c.bare?.includes(key) ? value : `${value} ${c.unit}`);
    }
  }
}

function setText(id: string, val: string | number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val);
}

// --- The dashboard charts ---
// One entry per chart: its canvas (`chart-<key>`), its toggle-button label, its
// grid cell, and how to turn a period's rows into datasets. The card markup,
// the toggles and the rendering all walk this list, so a chart can't end up
// drawn but untoggleable, or toggleable with no card to hide (both were
// possible while the cards lived in index.html). Each can be toggled off, which
// removes its whole grid column so the rest reflow to fill the row; the choice
// persists in localStorage.
interface ChartSpec {
  key: string;
  label: string;
  /** Appended to the label for the card heading: "Humidity (%)". */
  unit: string;
  type: string;
  /** Bootstrap column classes for this chart's cell. */
  col: string;
  /** Canvas height attribute — Chart.js uses it as the aspect-ratio hint. */
  height: number;
  datasets: (rows: WeatherRow[]) => any[];
  /** Chart-specific option overrides merged over CHART_DEFAULTS. */
  opts?: any;
}

const CHART_META: ChartSpec[] = [
  {
    key: 'temp', label: 'Temperature', unit: '°C', type: 'line', col: 'col-12 col-xl-8', height: 110,
    datasets: rows => [
      line('High', rows.map(r => r.temp_high), '#f87272'),
      line('Avg',  rows.map(r => r.temp_avg),  '#facc15'),
      line('Low',  rows.map(r => r.temp_low),  '#60a5fa'),
      line('Dew',  rows.map(r => r.dew_avg),   '#4ade80', { borderDash: [4, 3] }),
    ],
  },
  {
    key: 'precip', label: 'Precipitation', unit: 'mm', type: 'bar', col: 'col-12 col-xl-4', height: 110,
    datasets: rows => [
      { label: 'Precip', data: rows.map(r => r.precip), backgroundColor: '#60a5fa99' },
    ],
  },
  {
    key: 'hum', label: 'Humidity', unit: '%', type: 'line', col: 'col-12 col-md-6 col-xl-4', height: 120,
    datasets: rows => [
      line('High', rows.map(r => r.hum_high), '#f87272', { backgroundColor: '#f8727211', fill: true }),
      line('Avg',  rows.map(r => r.hum_avg),  '#facc15'),
      line('Low',  rows.map(r => r.hum_low),  '#60a5fa', { backgroundColor: '#60a5fa11', fill: true }),
    ],
    // Humidity is a percentage, so pin the axis rather than letting it autoscale.
    opts: { scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 } } },
  },
  {
    key: 'pres', label: 'Pressure', unit: 'hPa', type: 'line', col: 'col-12 col-md-6 col-xl-4', height: 120,
    datasets: rows => [
      line('High', rows.map(r => r.pres_high), '#a78bfa'),
      line('Low',  rows.map(r => r.pres_low),  '#818cf8', { backgroundColor: '#818cf811', fill: true }),
    ],
  },
  {
    key: 'wind', label: 'Wind', unit: 'km/h', type: 'line', col: 'col-12 col-md-6 col-xl-4', height: 120,
    datasets: rows => [
      line('High', rows.map(r => r.wind_high), '#fb923c', { backgroundColor: '#fb923c11', fill: true }),
      line('Avg',  rows.map(r => r.wind_avg),  '#fdba74'),
    ],
  },
];

// localStorage is unavailable (or full) in private/locked-down browsers, so
// both sides of the round-trip have to tolerate throwing.
function readStore<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
}
function writeStore(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function loadChartVisibility(): Record<string, boolean> {
  const saved = readStore<Record<string, boolean>>('chartVisibility', {});
  // Default visible: only an explicit `false` hides a chart.
  return Object.fromEntries(CHART_META.map(c => [c.key, saved[c.key] !== false]));
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
      writeStore('chartVisibility', chartVisibility);
      applyChartVisibility();
    });
    el.appendChild(btn);
  });
}

/**
 * One chart card: a Bootstrap column wrapping a titled canvas. The dashboard
 * and the Compare view both used to spell this out per chart in index.html —
 * nine near-identical ten-line blocks whose canvas ids had to match the two
 * metadata lists here by hand.
 */
function chartCard(o: {
  id: string; title: string; col: string; height: number; attr?: string;
}): string {
  return `
    <div class="${o.col}"${o.attr ?? ''}>
      <div class="card bg-secondary-subtle border-0">
        <div class="card-body">
          <h6 class="card-title text-muted">${o.title}</h6>
          <canvas id="${o.id}" height="${o.height}"></canvas>
        </div>
      </div>
    </div>`;
}

function renderChartCards(): void {
  document.getElementById('chart-cards')!.innerHTML = CHART_META.map(c =>
    chartCard({
      id: `chart-${c.key}`,
      title: `${c.label} (${c.unit})`,
      col: c.col,
      height: c.height,
      attr: ` data-chart="${c.key}"`,   // what applyChartVisibility() hides
    })).join('');
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
// One entry per column, driving both the header and every body cell. The
// header used to be hand-written in index.html, so a column added here had to
// be added there too, in the same position, or the table silently skewed.
interface TableColumn {
  label: string;
  cell: (r: WeatherRow) => string | number;
  /** Bootstrap class for the cell — a string, or per-row for conditional colour. */
  cls?: string | ((r: WeatherRow) => string);
}

const TABLE_COLUMNS: TableColumn[] = [
  { label: 'Date',      cell: r => r.date },
  { label: 'T High',    cell: r => r.temp_high, cls: 'text-danger' },
  { label: 'T Avg',     cell: r => r.temp_avg },
  { label: 'T Low',     cell: r => r.temp_low,  cls: 'text-info' },
  { label: 'Hum High',  cell: r => `${r.hum_high}%`, cls: 'text-danger' },
  { label: 'Hum Avg',   cell: r => `${r.hum_avg}%` },
  { label: 'Hum Low',   cell: r => `${r.hum_low}%`,  cls: 'text-info' },
  { label: 'Wind High', cell: r => r.wind_high, cls: 'text-warning' },
  { label: 'Wind Avg',  cell: r => r.wind_avg },
  { label: 'Pres High', cell: r => r.pres_high },
  { label: 'Pres Low',  cell: r => r.pres_low },
  { label: 'Precip',    cell: r => r.precip, cls: r => (r.precip > 0 ? 'text-primary' : '') },
];

function renderTableHead(): void {
  const head = document.getElementById('table-head');
  if (head) head.innerHTML = TABLE_COLUMNS.map(c => `<th>${c.label}</th>`).join('');
}

function renderTable(rows: WeatherRow[]): void {
  document.getElementById('table-body')!.innerHTML = rows.map(r =>
    `<tr>${TABLE_COLUMNS.map(c => {
      const cls = typeof c.cls === 'function' ? c.cls(r) : (c.cls ?? '');
      return `<td class="${cls}">${c.cell(r)}</td>`;
    }).join('')}</tr>`
  ).join('');
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
// The four measures both sources carry. One entry drives that measure's chart
// card, the chart itself (`cmp-<id>`) *and* its summary-table row; they used to
// be three hand-kept lists — two here and one in index.html — naming the same
// four keys.
interface CompareSpec {
  id: string;
  key: SharedKey;
  type: string;
  /** Suffix on the chart's series names ("Me · High"); bar charts use none. */
  series?: string;
  /** Heading on the chart card. */
  title: string;
  row: string;
}

const COMPARE_META: CompareSpec[] = [
  { id: 'cmp-temp-high', key: 'temp_high', type: 'line', series: 'High',
    title: 'Temperature High (°C)', row: 'Temp High (°C)' },
  { id: 'cmp-temp-low',  key: 'temp_low',  type: 'line', series: 'Low',
    title: 'Temperature Low (°C)',  row: 'Temp Low (°C)' },
  { id: 'cmp-precip',    key: 'precip',    type: 'bar',
    title: 'Precipitation (mm)',    row: 'Precip (mm)' },
  { id: 'cmp-wind',      key: 'wind_high', type: 'line', series: 'Wind',
    title: 'Wind Max (km/h)',       row: 'Wind Max (km/h)' },
];

function renderCompareCards(): void {
  document.getElementById('cmp-chart-cards')!.innerHTML = COMPARE_META.map(m =>
    chartCard({ id: m.id, title: m.title, col: 'col-12 col-xl-6', height: 110 })).join('');
}

const MINE_COLOR = '#38bdf8';
const PUBLIC_COLOR = '#fb923c';

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

  for (const m of COMPARE_META) {
    const datasets = m.type === 'bar'
      ? [
          { label: 'Me',   data: mineOf(m.key), backgroundColor: `${MINE_COLOR}99` },
          { label: 'Baar', data: pubOf(m.key),  backgroundColor: `${PUBLIC_COLOR}99` },
        ]
      : [
          line(`Me · ${m.series}`,   mineOf(m.key), MINE_COLOR),
          line(`Baar · ${m.series}`, pubOf(m.key),  PUBLIC_COLOR, { borderDash: [5, 3] }),
        ];
    mkChart(m.id, m.type, { labels: lbl, datasets });
  }

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
  const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(1));

  document.getElementById('cmp-summary-body')!.innerHTML = COMPARE_META.map(({ row: name, key }) => {
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
  renderPeriodTabs();
  renderStatCards();
  renderChartCards();
  renderCompareCards();
  renderTableHead();
  renderChartToggles();
  applyChartVisibility();   // apply persisted hidden state immediately, even before charts render
  await reloadDates();
})();
