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

/** `count` options numbered 1..count, labelled by `label` (default: the number). */
const numberOptions = (count: number, label: (n: number) => string = String) =>
  Array.from({ length: count }, (_, i) => ({ value: String(i + 1), label: label(i + 1) }));

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// The three numbered pickers the dashboard and the year-over-year view share.
const monthOptions = () => numberOptions(12, n => MONTH_NAMES[n - 1]);
const weekOptions = () => numberOptions(53, n => `Week ${n}`);
const dayOptions = () => numberOptions(31);

/** A small dimmed caption sitting next to a picker. */
const mutedLabel = (text: string) =>
  mkEl('span', { className: 'text-muted small', textContent: text });

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
    controls: el => el.append(yearSelect(), mkSelect(weekOptions(), String(isoWeek(refDate())), load)),
    url: s => `/api/week?year=${s[0]?.value}&week=${s[1]?.value}`,
  },

  month: {
    label: 'Month',
    controls: el => el.append(yearSelect(), mkSelect(monthOptions(), String(refDate().getMonth() + 1), load)),
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

      el.append(allWrap, mutedLabel('From'), fromSel, mutedLabel('To'), toSel);
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
      showView('dashboard');    // period tabs belong to the dashboard
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

/**
 * A signed-difference table cell — warm when it rose, cool when it fell, "—"
 * when either side is missing. Both comparison tables (mine-vs-public and
 * year-over-year) render their delta column this way.
 */
function deltaCell(diff: number | null, fmt: (n: number) => string): string {
  if (diff == null) return '<td>—</td>';
  const cls = diff > 0 ? 'text-danger' : diff < 0 ? 'text-info' : '';
  return `<td class="${cls}">${diff > 0 ? '+' : ''}${fmt(diff)}</td>`;
}

// The page has three mutually-exclusive views. Toggling one on turns the
// others off; both overlay buttons stay in sync from this single place, and
// the dashboard's period tabs (below) route back here.
type ViewName = 'dashboard' | 'compare' | 'yoy';
let currentView: ViewName = 'dashboard';

const compareBtn = document.getElementById('btn-compare')!;
const yoyBtn = document.getElementById('btn-yoy')!;

function showView(v: ViewName): void {
  currentView = v;
  document.getElementById('dashboard-view')!.classList.toggle('d-none', v !== 'dashboard');
  document.getElementById('compare-view')!.classList.toggle('d-none', v !== 'compare');
  document.getElementById('yoy-view')!.classList.toggle('d-none', v !== 'yoy');
  compareBtn.classList.toggle('active', v === 'compare');
  yoyBtn.classList.toggle('active', v === 'yoy');
  if (v === 'compare') loadCompare();
  if (v === 'yoy') { renderYoyControls(); loadYoy(); }
}

// Each overlay button toggles its own view, falling back to the dashboard.
compareBtn.addEventListener('click', () => showView(currentView === 'compare' ? 'dashboard' : 'compare'));
yoyBtn.addEventListener('click', () => showView(currentView === 'yoy' ? 'dashboard' : 'yoy'));

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
    return `<tr><td>${name}</td><td>${fmt(mine)}</td><td>${fmt(theirs)}</td>${
      deltaCell(diff, n => n.toFixed(1))}</tr>`;
  }).join('');
}

// --- Across years (year-over-year) ---
// Compare the SAME day, week or month across every year in the data. The server
// gathers each year's rows for the chosen period; here each year becomes one
// overlaid series (aligned on a shared within-period axis) plus one column in
// the averages table.
interface YearBlock { year: number; rows: WeatherRow[]; stats: Stats; }
interface YoyResponse { unit: YoyUnit; label: string; years: YearBlock[]; }

/**
 * One entry per comparison unit — its tab label, its value pickers, the query
 * those pickers imply, where a row sits inside the period and the shared
 * x-axis. Like PERIODS above, the unit is dispatched once here rather than in
 * four if/else chains (controls, url, position, axis) that had to stay in step.
 */
interface YoyUnitSpec {
  label: string;
  /** Appends this unit's value pickers after the unit selector. */
  controls: (el: HTMLElement) => void;
  /** Those pickers' values → the /api/across-years query string. */
  query: (vals: string[]) => string;
  /** The row's slot inside its period, so the same slot lines up across years. */
  pos: (r: WeatherRow) => number;
  /** The shared x-axis for this unit: slot positions and their labels. */
  axis: (label: string) => { positions: number[]; labels: string[] };
}

const YOY_UNITS = {
  day: {
    label: 'Day',
    controls: el => el.append(
      mkSelect(monthOptions(), String(refDate().getMonth() + 1), loadYoy),
      mkSelect(dayOptions(), String(refDate().getDate()), loadYoy),
    ),
    query: v => `unit=day&month=${v[0]}&day=${v[1]}`,
    pos: () => 1,                                        // a single slot
    axis: label => ({ positions: [1], labels: [label] }),
  },

  week: {
    label: 'Week',
    controls: el => el.append(mkSelect(weekOptions(), String(isoWeek(refDate())), loadYoy)),
    query: v => `unit=week&week=${v[0]}`,
    pos: r => {
      const [y, m, d] = r.date.split('-').map(Number);
      return new Date(y, m - 1, d).getDay() || 7;        // Mon=1..Sun=7
    },
    axis: () => ({
      positions: [1, 2, 3, 4, 5, 6, 7],
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    }),
  },

  month: {
    label: 'Month',
    controls: el => el.append(mkSelect(monthOptions(), String(refDate().getMonth() + 1), loadYoy)),
    query: v => `unit=month&month=${v[0]}`,
    pos: r => Number(r.date.slice(8, 10)),               // day of month, 1..31
    axis: () => {
      const positions = Array.from({ length: 31 }, (_, i) => i + 1);
      return { positions, labels: positions.map(String) };
    },
  },
} satisfies Record<string, YoyUnitSpec>;

type YoyUnit = keyof typeof YOY_UNITS;

// A distinct, cycled colour per year across all the charts.
const YEAR_COLORS = ['#38bdf8', '#fb923c', '#4ade80', '#f472b6', '#facc15', '#a78bfa'];
const yearColor = (i: number) => YEAR_COLORS[i % YEAR_COLORS.length];

// One chart per metric; each draws one line (or bar) per year. `get` reads the
// plotted value from a row — a function, not a key, so derived measures like
// mid-pressure fit the same list.
interface YoyMetric { id: string; title: string; type: string; get: (r: WeatherRow) => number; }
const YOY_METRICS: YoyMetric[] = [
  { id: 'yoy-temp-avg',  title: 'Temp Avg (°C)',    type: 'line', get: r => r.temp_avg },
  { id: 'yoy-temp-high', title: 'Temp High (°C)',   type: 'line', get: r => r.temp_high },
  { id: 'yoy-temp-low',  title: 'Temp Low (°C)',    type: 'line', get: r => r.temp_low },
  { id: 'yoy-hum-avg',   title: 'Humidity Avg (%)', type: 'line', get: r => r.hum_avg },
  { id: 'yoy-wind-high', title: 'Wind Max (km/h)',  type: 'line', get: r => r.wind_high },
  { id: 'yoy-pres-avg',  title: 'Pressure Avg (hPa)', type: 'line', get: r => (r.pres_high + r.pres_low) / 2 },
  { id: 'yoy-precip',    title: 'Precipitation (mm)', type: 'bar',  get: r => r.precip },
];

// The averages table, one row per stat, reading the server's aggregated stats.
const YOY_SUMMARY: { label: string; unit: string; get: (s: Stats) => number }[] = [
  { label: 'Temp avg',     unit: '°C',   get: s => s.temp.avg },
  { label: 'Temp high',    unit: '°C',   get: s => s.temp.high },
  { label: 'Temp low',     unit: '°C',   get: s => s.temp.low },
  { label: 'Humidity avg', unit: '%',    get: s => s.humidity.avg },
  { label: 'Wind max',     unit: 'km/h', get: s => s.wind.high },
  { label: 'Pressure avg', unit: 'hPa',  get: s => s.pressure.avg },
  { label: 'Precip total', unit: 'mm',   get: s => s.precip.total },
  { label: 'Rainy days',   unit: '',     get: s => s.precip.rainy_days },
];

// The current comparison unit; its value pickers are rebuilt when it changes.
let yoyUnit: YoyUnit = 'month';

function renderYoyCards(): void {
  document.getElementById('yoy-chart-cards')!.innerHTML = YOY_METRICS.map(m =>
    chartCard({ id: m.id, title: m.title, col: 'col-12 col-md-6 col-xl-4', height: 120 })).join('');
}

/** Rebuild the unit selector and the value pickers it implies. */
function renderYoyControls(): void {
  const el = document.getElementById('yoy-controls')!;
  el.innerHTML = '';

  const unitSel = mkSelect(
    (Object.keys(YOY_UNITS) as YoyUnit[]).map(k => ({ value: k, label: YOY_UNITS[k].label })),
    yoyUnit,
    () => { yoyUnit = unitSel.value as YoyUnit; renderYoyControls(); loadYoy(); },
  );
  el.append(mutedLabel('Compare'), unitSel);
  YOY_UNITS[yoyUnit].controls(el);
}

/** Turn the current value pickers into the /api/across-years call. */
function yoyUrl(): string {
  const vals = Array.from(document.getElementById('yoy-controls')!.querySelectorAll('select'))
    .slice(1)                                   // [0] is the unit selector
    .map(s => s.value);
  return `/api/across-years?${YOY_UNITS[yoyUnit].query(vals)}`;
}

async function loadYoy(): Promise<void> {
  const status = document.getElementById('yoy-status')!;
  status.textContent = 'Loading…';

  let data: YoyResponse;
  try {
    const r = await fetch(yoyUrl());
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    data = await r.json() as YoyResponse;
  } catch (e) {
    status.textContent = `Could not load: ${(e as Error).message}`;
    return;
  }

  document.getElementById('yoy-heading')!.textContent = `${data.label} across years`;
  if (!data.years.length) {
    status.textContent = 'No data for this period.';
    YOY_METRICS.forEach(m => destroyChart(m.id));
    document.getElementById('yoy-summary-head')!.innerHTML = '';
    document.getElementById('yoy-summary-body')!.innerHTML = '';
    return;
  }
  status.textContent = data.years.length < 2
    ? `Only ${data.years[0].year} has data for this period — add another year to compare.`
    : '';

  const spec = YOY_UNITS[data.unit];
  const { positions, labels: xlabels } = spec.axis(data.label);
  // Per year: within-period slot → that day's row, so each x-slot can pull each
  // year's value (or null where a year is missing that day).
  const byPos = data.years.map(yb => new Map(yb.rows.map(row => [spec.pos(row), row])));

  for (const metric of YOY_METRICS) {
    const datasets = data.years.map((yb, i) => {
      const arr = positions.map(p => { const row = byPos[i].get(p); return row ? metric.get(row) : null; });
      return metric.type === 'bar'
        ? { label: String(yb.year), data: arr, backgroundColor: `${yearColor(i)}99` }
        : line(String(yb.year), arr, yearColor(i));
    });
    mkChart(metric.id, metric.type, { labels: xlabels, datasets });
  }

  renderYoySummary(data);
}

function renderYoySummary(data: YoyResponse): void {
  const round = (v: number) => Math.round(v * 10) / 10;
  const yearCols = data.years.map(y => `<th>${y.year}</th>`).join('');
  // With ≥2 years, a trailing column shows the change from the earliest to the
  // latest year — the headline "how did this period differ" number.
  const hasDelta = data.years.length >= 2;
  document.getElementById('yoy-summary-head')!.innerHTML =
    `<th>Metric</th>${yearCols}${hasDelta ? '<th>Δ latest−earliest</th>' : ''}`;

  document.getElementById('yoy-summary-body')!.innerHTML = YOY_SUMMARY.map(m => {
    const vals = data.years.map(y => m.get(y.stats));
    const suffix = m.unit ? ` ${m.unit}` : '';
    const cells = vals.map(v => `<td>${v}${suffix}</td>`).join('');
    const delta = hasDelta
      ? deltaCell(round(vals[vals.length - 1] - vals[0]), n => `${n}${suffix}`)
      : '';
    return `<tr><td>${m.label}</td>${cells}${delta}</tr>`;
  }).join('');
}

// --- Init ---
(async () => {
  renderPeriodTabs();
  renderStatCards();
  renderChartCards();
  renderCompareCards();
  renderYoyCards();
  renderTableHead();
  renderChartToggles();
  applyChartVisibility();   // apply persisted hidden state immediately, even before charts render
  await reloadDates();
})();
