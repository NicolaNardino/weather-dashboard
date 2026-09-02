/* Weather dashboard front-end.
   Source of truth is this TypeScript file; it compiles to public/app.js
   (see tsconfig.client.json). Chart.js is loaded globally from a CDN. */

declare const Chart: any;

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

/**
 * Chart options: `extra` over CHART_DEFAULTS, merged one level into each axis
 * so a chart can pin a single scale (`{ scales: { y: { min: 0 } } }`) without
 * restating the shared tick/grid styling — a plain spread dropped it, which the
 * one chart that pins an axis had to work around by spelling the defaults back
 * out twice.
 */
function chartOptions(extra: any): any {
  const { scales, ...rest } = extra;
  return {
    ...CHART_DEFAULTS,
    ...rest,
    scales: {
      x: { ...CHART_DEFAULTS.scales.x, ...scales?.x },
      y: { ...CHART_DEFAULTS.scales.y, ...scales?.y },
    },
  };
}

function mkChart(id: string, type: string, data: any, extraOpts: any = {}): void {
  const ctx = document.getElementById(id);
  destroyChart(id);
  charts[id] = new Chart(ctx, { type, data, options: chartOptions(extraOpts) });
}

/**
 * Draw one chart per spec onto a shared x-axis. All three views — the
 * dashboard, Compare and Across Years — walk their own metadata list, and each
 * spelled out the same `mkChart(id, spec.type, { labels, datasets })` call;
 * they differ only in how a spec names its canvas and becomes datasets.
 */
function drawCharts<T extends { type: string; opts?: any }>(
  specs: readonly T[],
  labels: string[],
  id: (spec: T) => string,
  datasets: (spec: T) => any[],
): void {
  for (const spec of specs) {
    mkChart(id(spec), spec.type, { labels, datasets: datasets(spec) }, spec.opts);
  }
}

/**
 * One dataset in a chart that can be drawn either way: a translucent bar, or a
 * line with the shared styling (which `extra` overrides). Every chart on the
 * page picks between the two forms per metric, and each spelled the same
 * ternary out.
 */
function series(
  type: string, label: string, data: (number | null)[], color: string, extra: any = {},
): any {
  return type === 'bar'
    ? { label, data, backgroundColor: `${color}99` }
    : {
        label,
        data,
        borderColor: color,
        backgroundColor: 'transparent',
        pointRadius: 2,
        tension: 0.3,
        ...extra,
      };
}

/**
 * The last element of a list — the newest date, the latest year, the most
 * recent row. Seven call sites each spelled out the same `xs[xs.length - 1]`
 * index arithmetic, which reads as a bounds calculation rather than as the one
 * thing it ever means here.
 */
const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

/** `getElementById`, asserted — every id below is one this page owns. */
const el = (id: string) => document.getElementById(id)!;

/** Replace an element's markup. Every render function below ends in this. */
const setHtml = (id: string, html: string): void => { el(id).innerHTML = html; };

/**
 * Fill a container with one chunk of markup per item — cards, table heads,
 * table rows. Every render function below built the same `.map(…).join('')`
 * around its own row template.
 */
function renderList<T>(id: string, items: readonly T[], row: (item: T) => string): void {
  setHtml(id, items.map(row).join(''));
}

/** Empty a container and hand it back, ready to `append()` built nodes into. */
function emptyEl(id: string): HTMLElement {
  const node = el(id);
  node.innerHTML = '';
  return node;
}

/**
 * Table markup. Every table on the page — the dashboard's data table and the
 * two comparison summaries — built its own `<td class="…">` / `<th>` / `<tr>`
 * strings, so the class attribute was spelled out even when empty in one place
 * and omitted in another. One cell builder covers all six sites.
 */
const cell = (tag: 'td' | 'th', content: string | number, cls = ''): string =>
  `<${tag}${cls ? ` class="${cls}"` : ''}>${content}</${tag}>`;
const td = (content: string | number, cls = '') => cell('td', content, cls);
const th = (content: string | number, cls = '') => cell('th', content, cls);
const tr = (cells: string[]) => `<tr>${cells.join('')}</tr>`;

/**
 * The Bootstrap card well every panel on the page sits in: a
 * `bg-secondary-subtle` card wrapping a card body. The three builders below —
 * the stat cards, the chart cards and the table cards — each spelled the same
 * two class-laden divs out, differing only in a modifier on each, so the shared
 * classes lived nowhere and one of the three could drift.
 */
const cardWell = (o: { body: string; cls?: string; bodyCls?: string }): string =>
  `<div class="card bg-secondary-subtle border-0${o.cls ? ` ${o.cls}` : ''}">
     <div class="card-body${o.bodyCls ? ` ${o.bodyCls}` : ''}">${o.body}</div>
   </div>`;

/**
 * A table sitting in a card well: `<thead><tr id="…-head">` over
 * `<tbody id="…-body">`, both filled in later. All three tables spelled the
 * same five-element nesting out in index.html, differing only in their ids and
 * one class — and each carried an id on the `<table>` itself that nothing read.
 */
function renderTableCard(id: string, hover = false): void {
  setHtml(
    id,
    cardWell({
      cls: 'mb-3',
      bodyCls: 'p-0',
      body: `<div class="table-responsive">
           <table class="table table-dark table-sm${hover ? ' table-hover' : ''} mb-0 small">
             <thead><tr id="${id}-head"></tr></thead>
             <tbody id="${id}-body"></tbody>
           </table>
         </div>`,
    }),
  );
}

/**
 * GET a JSON endpoint, turning a non-2xx into a throw that carries the server's
 * own `{ error }` text. Every loader below made the same fetch / check `ok` /
 * parse / fall back to `statusText` sequence.
 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return await r.json() as T;
}

/** "2026-04-07" → that day as a local Date (the pickers all work in local time). */
function localDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
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
// Fixed lists — the calendar doesn't change — so they are built once rather
// than rebuilt on every render.
const MONTH_OPTIONS = numberOptions(12, n => MONTH_NAMES[n - 1]);
const WEEK_OPTIONS = numberOptions(53, n => `Week ${n}`);
const DAY_OPTIONS = numberOptions(31);

/**
 * Those pickers, each pre-selected to the reference date's own week / month /
 * day. The dashboard's period list and the year-over-year one both offer the
 * same three and differ only in what a change reloads — so each spelled the
 * same default out again, and a picker could end up defaulting to the reference
 * date in one view but not the other.
 */
const weekSelect = (onChange: () => void) =>
  mkSelect(WEEK_OPTIONS, String(isoWeek(refDate())), onChange);
const monthSelect = (onChange: () => void) =>
  mkSelect(MONTH_OPTIONS, String(refDate().getMonth() + 1), onChange);
const daySelect = (onChange: () => void) =>
  mkSelect(DAY_OPTIONS, String(refDate().getDate()), onChange);

/** A small dimmed caption sitting next to a picker. */
const mutedLabel = (text: string) =>
  mkEl('span', { className: 'text-muted small', textContent: text });

/**
 * Fill a `btn-group` with one button per item and keep their pressed state in
 * step with whatever `active` reads. Both button groups on the page — the
 * period tabs and the chart toggles — built their buttons the same way and then
 * re-stated the active class in their own way: the tabs by re-rendering the
 * whole group on every click, the toggles through a per-button `sync` closure.
 * Re-reading `active` for every button after a click covers both, so a group
 * can't be left showing a stale selection.
 */
function renderButtonGroup<T>(
  id: string,
  items: readonly T[],
  o: {
    label: (item: T) => string;
    active: (item: T) => boolean;
    onClick: (item: T) => void;
    /** Extra per-button setup, e.g. the `data-period` the harness clicks. */
    each?: (item: T, btn: HTMLButtonElement) => void;
  },
): void {
  const box = emptyEl(id);
  const buttons = items.map(item => {
    const btn = mkEl('button', {
      type: 'button',
      className: 'btn btn-outline-secondary',
      textContent: o.label(item),
    });
    o.each?.(item, btn);
    btn.addEventListener('click', () => { o.onClick(item); sync(); });
    box.append(btn);
    return { item, btn };
  });

  function sync(): void {
    for (const { item, btn } of buttons) {
      const on = o.active(item);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }
  sync();
}

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
    controls: (el, dates) => el.append(mkSelect(asOptions(dates), last(dates), load)),
    url: s => `/api/day?date=${s[0]?.value ?? ''}`,
  },

  week: {
    label: 'Week',
    controls: el => el.append(yearSelect(load), weekSelect(load)),
    url: s => `/api/week?year=${s[0]?.value}&week=${s[1]?.value}`,
  },

  month: {
    label: 'Month',
    controls: el => el.append(yearSelect(load), monthSelect(load)),
    url: s => `/api/month?year=${s[0]?.value}&month=${s[1]?.value}`,
  },

  year: {
    label: 'Year',
    controls: el => el.append(yearSelect(load)),
    url: s => `/api/year?year=${s[0]?.value}`,
  },

  range: {
    label: 'Range',
    // Two date pickers populated ONLY from dates that exist in the data,
    // so the user can never select a window outside the recorded range.
    // From defaults to the last ~30 available days for a sensible window.
    controls: (el, dates) => {
      const fromSel = mkSelect(asOptions(dates), dates[Math.max(0, dates.length - 30)], load);
      const toSel = mkSelect(asOptions(dates), last(dates), load);

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
      const all = (document.getElementById('range-all') as HTMLInputElement | null)?.checked;
      let [from, to] = all && allDates.length
        ? [allDates[0], last(allDates)]                  // whole dataset
        : [s[0]?.value, s[1]?.value];
      if (from && to && from > to) [from, to] = [to, from]; // tolerate reversed picks
      return `/api/range?from=${from}&to=${to}`;
    },
  },
} satisfies Record<string, PeriodSpec>;

type Period = keyof typeof PERIODS;

// --- State ---
let period: Period = 'week';
/** Every date the data holds, ascending — the pool every picker draws from. */
let allDates: string[] = [];
let lastRows: WeatherRow[] = [];   // rows from the most recent dashboard load (drives Compare range)

// --- Nav tabs ---
// Built from PERIODS, like every other list on the page. The tabs used to be
// hand-written in index.html — a fifth copy of the period names that could
// offer a period the dashboard didn't implement, which the click handler had
// to guard against.
function renderPeriodTabs(): void {
  renderButtonGroup('period-tabs', Object.keys(PERIODS) as Period[], {
    label: key => PERIODS[key].label,
    active: key => key === period,
    each: (key, btn) => { btn.dataset.period = key; },   // the harness clicks these
    onClick: key => {
      period = key;
      showView('dashboard');    // period tabs belong to the dashboard
      renderControls();
      load();
    },
  });
}

// --- Controls ---
function renderControls(): void {
  PERIODS[period].controls(emptyEl('controls'), allDates);
}

function yearSelect(onChange: () => void): HTMLSelectElement {
  const thisYear = String(new Date().getFullYear());
  const years = [...new Set(allDates.map(d => d.slice(0, 4)))];
  return mkSelect(
    asOptions(years.length ? years : [thisYear]),
    last(years) || thisYear,
    onChange,
  );
}

// Reference date = latest date that actually has data (falls back to today
// when no data is loaded). Selectors default to this period so a fresh load
// lands on populated data rather than the empty calendar-current period.
function refDate(): Date {
  const latest = last(allDates);
  return latest ? localDate(latest) : new Date();
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
  allDates = await fetchJson<string[]>('/api/dates');
  renderControls();
  await load();
  await refreshStatus();
}

// --- Load data ---
async function load(): Promise<void> {
  const sels = Array.from(el('controls').querySelectorAll('select'));

  let data: { rows: WeatherRow[]; stats: Stats };
  try {
    data = await fetchJson<{ rows: WeatherRow[]; stats: Stats }>(PERIODS[period].url(sels));
  } catch {
    // A period the server has no data for (the day route 404s) — blank the
    // dashboard rather than leaving the previous period's rows on screen.
    lastRows = [];
    clearAll();
    return;
  }

  lastRows = data.rows;
  renderStats(data.stats);
  renderCharts(data.rows);
  renderTable(data.rows);
}

// --- Data freshness (last import time) ---
async function refreshStatus(): Promise<void> {
  try {
    const { last_import, records } =
      await fetchJson<{ last_import: string | null; records: number }>('/api/status');
    const stamp = el('last-import');
    if (last_import) {
      const when = new Date(last_import);
      stamp.textContent = `Imported ${when.toLocaleString()} · ${records} records`;
      stamp.title = `Last import: ${when.toString()}`;
    } else {
      stamp.textContent = 'Not yet imported';
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

/** A card's stat, with its unit appended — a count (see `bare`) carries none. */
const statText = (card: StatCard, key: string, value: number | string): string =>
  card.bare?.includes(key) ? String(value) : `${value} ${card.unit}`;

/** The card a stats group belongs to, by prefix — how a metric finds its unit. */
const CARD_BY_PREFIX: Record<string, StatCard> = Object.fromEntries(
  STAT_CARDS.map(c => [c.prefix, c]),
);

/**
 * Where one stat's value is written. `renderStatCards` puts this id on the
 * element and `renderStats` finds it again by the same name, so the template
 * has to agree across the two — it was spelled out three times (the headline,
 * the sub-line spans, and the lookup) with nothing tying them together.
 */
const statId = (prefix: string, key: string) => `s-${prefix}-${key}`;

const statSpan = (prefix: string, key: string) => `<span id="${statId(prefix, key)}">—</span>`;

function renderStatCards(): void {
  renderList('stat-cards', STAT_CARDS, c => `
    <div class="col-6 col-md-4 col-xl-2">
      ${cardWell({
        cls: 'h-100',
        bodyCls: 'p-3',
        body: `<div class="text-muted small">${c.title}</div>
          <div class="fs-4 fw-bold" id="${statId(c.prefix, c.headline)}">—</div>
          <div class="small text-muted">${c.sub
            .map(p => `${p.before ?? ''}${statSpan(c.prefix, p.key)}${p.after ?? ''}`)
            .join('')}</div>`,
      })}
    </div>`);
}

function renderStats(s: Stats | undefined): void {
  if (!s) return;
  for (const c of STAT_CARDS) {
    for (const [key, value] of Object.entries(c.pick(s))) {
      // A group can carry keys no card shows (precip.max); setText ignores those.
      setText(statId(c.prefix, key), statText(c, key, value));
    }
  }
}

/** Like `el`, but tolerates a missing element — a stats group can carry keys no
    card renders, so those ids simply aren't on the page. (Named `node` rather
    than `el`, which shadowed the asserting helper of that name above.) */
function setText(id: string, val: string | number): void {
  const node = document.getElementById(id);
  if (node) node.textContent = String(val);
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
  /** One entry per plotted series: which measure it reads, and how it looks. */
  series: { label: string; field: Measure; color: string; extra?: any }[];
  /** Chart-specific option overrides merged over CHART_DEFAULTS. */
  opts?: any;
}

/** A stored measure a dashboard series can plot. */
type Measure = Exclude<keyof WeatherRow, 'date'>;

const CHART_META: ChartSpec[] = [
  {
    key: 'temp', label: 'Temperature', unit: '°C', type: 'line', col: 'col-12 col-xl-8', height: 110,
    series: [
      { label: 'High', field: 'temp_high', color: '#f87272' },
      { label: 'Avg',  field: 'temp_avg',  color: '#facc15' },
      { label: 'Low',  field: 'temp_low',  color: '#60a5fa' },
      { label: 'Dew',  field: 'dew_avg',   color: '#4ade80', extra: { borderDash: [4, 3] } },
    ],
  },
  {
    key: 'precip', label: 'Precipitation', unit: 'mm', type: 'bar', col: 'col-12 col-xl-4', height: 110,
    series: [{ label: 'Precip', field: 'precip', color: '#60a5fa' }],
  },
  {
    key: 'hum', label: 'Humidity', unit: '%', type: 'line', col: 'col-12 col-md-6 col-xl-4', height: 120,
    series: [
      { label: 'High', field: 'hum_high', color: '#f87272', extra: { backgroundColor: '#f8727211', fill: true } },
      { label: 'Avg',  field: 'hum_avg',  color: '#facc15' },
      { label: 'Low',  field: 'hum_low',  color: '#60a5fa', extra: { backgroundColor: '#60a5fa11', fill: true } },
    ],
    // Humidity is a percentage, so pin the axis rather than letting it autoscale.
    opts: { scales: { y: { min: 0, max: 100 } } },
  },
  {
    key: 'pres', label: 'Pressure', unit: 'hPa', type: 'line', col: 'col-12 col-md-6 col-xl-4', height: 120,
    series: [
      { label: 'High', field: 'pres_high', color: '#a78bfa' },
      { label: 'Low',  field: 'pres_low',  color: '#818cf8', extra: { backgroundColor: '#818cf811', fill: true } },
    ],
  },
  {
    key: 'wind', label: 'Wind', unit: 'km/h', type: 'line', col: 'col-12 col-md-6 col-xl-4', height: 120,
    series: [
      { label: 'High', field: 'wind_high', color: '#fb923c', extra: { backgroundColor: '#fb923c11', fill: true } },
      { label: 'Avg',  field: 'wind_avg',  color: '#fdba74' },
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

/**
 * A dashboard chart's canvas id. COMPARE_META and YOY_METRICS each name their
 * canvas outright; only these are derived from the key — and four places (the
 * card, the draw, the visibility resize and the teardown) each spelled the same
 * template out, so the id lived nowhere.
 */
const chartId = (key: string) => `chart-${key}`;

function applyChartVisibility(): void {
  CHART_META.forEach(c => {
    const visible = chartVisibility[c.key];
    document.querySelector<HTMLElement>(`[data-chart="${c.key}"]`)?.classList.toggle('d-none', !visible);
    // A chart that just became visible was sized to a hidden (0-width) canvas;
    // nudge Chart.js to re-measure now that the column has real dimensions.
    if (visible) charts[chartId(c.key)]?.resize();
  });
}

function renderChartToggles(): void {
  renderButtonGroup('chart-toggles', CHART_META, {
    label: c => c.label,
    active: c => chartVisibility[c.key],
    onClick: c => {
      chartVisibility[c.key] = !chartVisibility[c.key];
      writeStore('chartVisibility', chartVisibility);
      applyChartVisibility();
    },
  });
}

/**
 * One chart card: a Bootstrap column wrapping a titled canvas. The dashboard
 * and the Compare view both used to spell this out per chart in index.html —
 * nine near-identical ten-line blocks whose canvas ids had to match the two
 * metadata lists here by hand.
 *
 * `chartKey` tags the column with the `data-chart` attribute
 * `applyChartVisibility()` hides it by; only the dashboard's cards carry one.
 */
function chartCard(o: {
  id: string; title: string; col: string; height: number; chartKey?: string;
}): string {
  return `
    <div class="${o.col}"${o.chartKey ? ` data-chart="${o.chartKey}"` : ''}>
      ${cardWell({
        body: `<h6 class="card-title text-muted">${o.title}</h6>
          <canvas id="${o.id}" height="${o.height}"></canvas>`,
      })}
    </div>`;
}

function renderChartCards(): void {
  renderList('chart-cards', CHART_META, c =>
    chartCard({
      id: chartId(c.key),
      title: `${c.label} (${c.unit})`,
      col: c.col,
      height: c.height,
      chartKey: c.key,
    }));
}

// --- Charts ---
function labels(rows: WeatherRow[]): string[] {
  return rows.map(r => r.date.slice(5)); // MM-DD
}

function renderCharts(rows: WeatherRow[]): void {
  drawCharts(CHART_META, labels(rows), c => chartId(c.key), c =>
    c.series.map(s => series(c.type, s.label, rows.map(r => r[s.field]), s.color, s.extra)));
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
  renderList('data-table-head', TABLE_COLUMNS, c => th(c.label));
}

function renderTable(rows: WeatherRow[]): void {
  renderList('data-table-body', rows, r =>
    tr(TABLE_COLUMNS.map(c => td(c.cell(r), typeof c.cls === 'function' ? c.cls(r) : c.cls))),
  );
}

function clearAll(): void {
  CHART_META.forEach(({ key }) => destroyChart(chartId(key)));
  setHtml('data-table-body', '');
}

// --- Import button ---
const importBtn = document.getElementById('btn-import') as HTMLButtonElement;
importBtn.addEventListener('click', async () => {
  importBtn.textContent = '…';
  importBtn.disabled = true;
  try {
    const j = await fetchJson<{ total: number; inserted: number; updated: number; unchanged: number }>(
      '/api/import', { method: 'POST' },
    );
    // Report what actually changed, not just the row count in the file.
    importBtn.textContent = `✓ ${j.inserted} new · ${j.updated} upd`;
    importBtn.title = `${j.total} rows processed — ${j.inserted} new, ${j.updated} updated, ${j.unchanged} unchanged`;
    await reloadDates();
  } catch {
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
  renderList('cmp-chart-cards', COMPARE_META, m =>
    chartCard({ id: m.id, title: m.title, col: 'col-12 col-xl-6', height: 110 }));
}

const MINE_COLOR = '#38bdf8';
const PUBLIC_COLOR = '#fb923c';

/**
 * A signed-difference table cell — warm when it rose, cool when it fell, "—"
 * when either side is missing. Both comparison tables (mine-vs-public and
 * year-over-year) render their delta column this way.
 */
function deltaCell(diff: number | null, fmt: (n: number) => string): string {
  if (diff == null) return td('—');
  return td(`${diff > 0 ? '+' : ''}${fmt(diff)}`, diff > 0 ? 'text-danger' : diff < 0 ? 'text-info' : '');
}

// The page has three mutually-exclusive views, each `<name>-view` in the markup:
// the dashboard, plus two overlays reached from their own navbar button. One
// entry per overlay drives the button's active state, its toggle handler and
// what showing it loads — they used to be spelled out in four places (three
// `classList.toggle` lines, two button syncs, two `if (v === …)` loads and two
// click handlers) that all had to name the same view.
const OVERLAYS = [
  { name: 'compare', btn: el('btn-compare'), show: () => loadCompare() },
  { name: 'yoy', btn: el('btn-yoy'), show: () => { renderYoyControls(); loadYoy(); } },
] as const;

type ViewName = 'dashboard' | (typeof OVERLAYS)[number]['name'];
let currentView: ViewName = 'dashboard';

function showView(v: ViewName): void {
  currentView = v;
  el('dashboard-view').classList.toggle('d-none', v !== 'dashboard');
  // One pass per overlay: hide or show its view, sync its button, and load it
  // if it is the one being shown. These were three separate walks of OVERLAYS —
  // one of them over a throwaway array rebuilt on every switch.
  for (const o of OVERLAYS) {
    const on = o.name === v;
    el(`${o.name}-view`).classList.toggle('d-none', !on);
    o.btn.classList.toggle('active', on);
    if (on) o.show();
  }
}

// Each overlay button toggles its own view, falling back to the dashboard.
for (const o of OVERLAYS) {
  o.btn.addEventListener('click', () => showView(currentView === o.name ? 'dashboard' : o.name));
}

/**
 * Load an overlay view's data, reporting progress and failure on that view's
 * own status line rather than throwing. Both overlays spelled out the same
 * announce / fetch / catch-into-the-status-line sequence.
 */
async function loadInto<T>(
  statusId: string, url: string, loading: string, failure: string,
): Promise<T | null> {
  const status = el(statusId);
  status.textContent = loading;
  try {
    const data = await fetchJson<T>(url);
    status.textContent = '';
    return data;
  } catch (e) {
    status.textContent = `${failure}: ${(e as Error).message}`;
    return null;
  }
}

async function loadCompare(): Promise<void> {
  if (!lastRows.length) {
    el('cmp-status').textContent = 'No local data selected — pick a period on the dashboard first.';
    return;
  }
  const from = lastRows[0].date;
  const to = last(lastRows)!.date;
  el('cmp-range').textContent = `${from} → ${to}`;

  const data = await loadInto<{ mine: WeatherRow[]; public: PublicRow[] }>(
    'cmp-status', `/api/compare?from=${from}&to=${to}`,
    'Loading public data…', 'Could not fetch public data',
  );
  if (!data) return;

  // Align public rows to my dates so both series share the same x-axis.
  const pub = new Map<string, PublicRow>(data.public.map(p => [p.date, p]));
  const mineOf = (key: SharedKey) => lastRows.map(r => r[key] as number);
  const pubOf  = (key: SharedKey) => lastRows.map(r => (pub.get(r.date)?.[key] ?? null) as number | null);

  drawCharts(COMPARE_META, labels(lastRows), m => m.id, m => {
    // Lines name their measure ("Me · High"); the bar chart has only one.
    const suffix = m.series ? ` · ${m.series}` : '';
    return [
      series(m.type, `Me${suffix}`, mineOf(m.key), MINE_COLOR),
      series(m.type, `Baar${suffix}`, pubOf(m.key), PUBLIC_COLOR, { borderDash: [5, 3] }),
    ];
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
  const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(1));

  renderList('cmp-summary-body', COMPARE_META, ({ row: name, key }) => {
    const mine = avg(mineOf(key));
    const theirs = avg(pubOf(key));
    const diff = (mine != null && theirs != null) ? mine - theirs : null;
    return tr([td(name), td(fmt(mine)), td(fmt(theirs)), deltaCell(diff, n => n.toFixed(1))]);
  });
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
    controls: el => el.append(monthSelect(loadYoy), daySelect(loadYoy)),
    query: v => `unit=day&month=${v[0]}&day=${v[1]}`,
    pos: () => 1,                                        // a single slot
    axis: label => ({ positions: [1], labels: [label] }),
  },

  week: {
    label: 'Week',
    controls: el => el.append(weekSelect(loadYoy)),
    query: v => `unit=week&week=${v[0]}`,
    pos: r => localDate(r.date).getDay() || 7,           // Mon=1..Sun=7
    axis: () => ({
      positions: [1, 2, 3, 4, 5, 6, 7],
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    }),
  },

  month: {
    label: 'Month',
    controls: el => el.append(monthSelect(loadYoy)),
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

// The averages table, one row per stat. A row names the stat card it reads —
// `prefix` picks the group out of the server's aggregated stats, `key` the value
// within it — so the accessor and the unit both come from STAT_CARDS. Spelling
// them out again here meant eight units and eight accessors that had to stay in
// step with the cards showing the very same numbers.
const YOY_SUMMARY: { label: string; prefix: string; key: string }[] = [
  { label: 'Temp avg',     prefix: 'temp',   key: 'avg' },
  { label: 'Temp high',    prefix: 'temp',   key: 'high' },
  { label: 'Temp low',     prefix: 'temp',   key: 'low' },
  { label: 'Humidity avg', prefix: 'hum',    key: 'avg' },
  { label: 'Wind max',     prefix: 'wind',   key: 'high' },
  { label: 'Pressure avg', prefix: 'pres',   key: 'avg' },
  { label: 'Precip total', prefix: 'precip', key: 'total' },
  { label: 'Rainy days',   prefix: 'precip', key: 'rainy_days' },
];

// The current comparison unit; its value pickers are rebuilt when it changes.
let yoyUnit: YoyUnit = 'month';

function renderYoyCards(): void {
  renderList('yoy-chart-cards', YOY_METRICS, m =>
    chartCard({ id: m.id, title: m.title, col: 'col-12 col-md-6 col-xl-4', height: 120 }));
}

/** Rebuild the unit selector and the value pickers it implies. */
function renderYoyControls(): void {
  const controls = emptyEl('yoy-controls');

  const unitSel = mkSelect(
    (Object.keys(YOY_UNITS) as YoyUnit[]).map(k => ({ value: k, label: YOY_UNITS[k].label })),
    yoyUnit,
    () => { yoyUnit = unitSel.value as YoyUnit; renderYoyControls(); loadYoy(); },
  );
  controls.append(mutedLabel('Compare'), unitSel);
  YOY_UNITS[yoyUnit].controls(controls);
}

/** Turn the current value pickers into the /api/across-years call. */
function yoyUrl(): string {
  const vals = Array.from(el('yoy-controls').querySelectorAll('select'))
    .slice(1)                                   // [0] is the unit selector
    .map(s => s.value);
  return `/api/across-years?${YOY_UNITS[yoyUnit].query(vals)}`;
}

async function loadYoy(): Promise<void> {
  const status = el('yoy-status');
  const data = await loadInto<YoyResponse>('yoy-status', yoyUrl(), 'Loading…', 'Could not load');
  if (!data) return;

  el('yoy-heading').textContent = `${data.label} across years`;
  if (!data.years.length) {
    status.textContent = 'No data for this period.';
    YOY_METRICS.forEach(m => destroyChart(m.id));
    setHtml('yoy-summary-head', '');
    setHtml('yoy-summary-body', '');
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

  drawCharts(YOY_METRICS, xlabels, m => m.id, metric =>
    data.years.map((yb, i) =>
      series(
        metric.type,
        String(yb.year),
        positions.map(p => { const row = byPos[i].get(p); return row ? metric.get(row) : null; }),
        yearColor(i),
      )));

  renderYoySummary(data);
}

function renderYoySummary(data: YoyResponse): void {
  const round = (v: number) => Math.round(v * 10) / 10;
  // With ≥2 years, a trailing column shows the change from the earliest to the
  // latest year — the headline "how did this period differ" number.
  const hasDelta = data.years.length >= 2;
  setHtml(
    'yoy-summary-head',
    [th('Metric'), ...data.years.map(y => th(y.year)), ...(hasDelta ? [th('Δ latest−earliest')] : [])]
      .join(''),
  );

  renderList('yoy-summary-body', YOY_SUMMARY, m => {
    const card = CARD_BY_PREFIX[m.prefix];
    const text = (v: number) => statText(card, m.key, v);
    const vals = data.years.map(y => card.pick(y.stats)[m.key]);
    const delta = hasDelta
      ? [deltaCell(round(last(vals)! - vals[0]), text)]
      : [];
    return tr([td(m.label), ...vals.map(v => td(text(v))), ...delta]);
  });
}

// --- Init ---
(async () => {
  renderPeriodTabs();
  renderStatCards();
  renderChartCards();
  renderCompareCards();
  renderYoyCards();
  renderTableCard('data-table', true);
  renderTableCard('cmp-summary');
  renderTableCard('yoy-summary');
  renderTableHead();
  // The compare summary's columns are fixed; the other two heads are rendered
  // from their own metadata when their data arrives.
  renderList('cmp-summary-head', ['Metric', 'My avg', 'Baar avg', 'Difference'], c => th(c));
  renderChartToggles();
  applyChartVisibility();   // apply persisted hidden state immediately, even before charts render
  await reloadDates();
})();
