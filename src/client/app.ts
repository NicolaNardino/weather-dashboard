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
  const ctx = el(id);
  destroyChart(id);
  charts[id] = new Chart(ctx, { type, data, options: chartOptions(extraOpts) });
}

/**
 * What every chart spec on the page carries, whichever view it belongs to: how
 * it is drawn, and optionally its own card geometry where that differs from the
 * group's.
 */
interface ChartSpecBase {
  /** Chart.js type. Every chart here is a line unless it says otherwise, so
      only the two bar charts carry one — thirteen specs across the three lists
      restated `type: 'line'`, and `drawCharts` now resolves the default once. */
  type?: string;
  /** Chart-specific option overrides merged over CHART_DEFAULTS. */
  opts?: any;
  /** Overrides the group's column classes / canvas height for this chart. */
  col?: string;
  height?: number;
}

/**
 * A view's charts as one thing: where their cards go, how a spec names and
 * titles its canvas, and the cell geometry they share.
 *
 * The three views — the dashboard, Compare and Across Years — each used to
 * restate that at every point which touched their charts: a card renderer, a
 * `drawCharts` call and a teardown loop all named the same canvas their own
 * way, and the three card renderers were the same `renderList(container,
 * specs, chartCard(…))` written out three times.
 */
interface ChartGroup<T extends ChartSpecBase> {
  /** Container the cards are rendered into. */
  container: string;
  specs: readonly T[];
  /** This spec's canvas id. */
  id: (spec: T) => string;
  /** Heading on this spec's card. */
  title: (spec: T) => string;
  /** Card geometry for the group; a spec's own `col`/`height` wins. */
  col: string;
  height: number;
  /**
   * Tag each column with the `data-chart` attribute `applyChartVisibility()`
   * hides it by. Only the dashboard's charts can be toggled off.
   */
  toggleKey?: (spec: T) => string;
}

/** Render one card per chart in the group. */
function renderChartGroup<T extends ChartSpecBase>(g: ChartGroup<T>): void {
  renderList(g.container, g.specs, spec =>
    chartCard({
      id: g.id(spec),
      title: g.title(spec),
      col: spec.col ?? g.col,
      height: spec.height ?? g.height,
      chartKey: g.toggleKey?.(spec),
    }));
}

/**
 * Draw one chart per spec in the group onto a shared x-axis. The views differ
 * only in how a spec becomes datasets — which need the resolved chart type, so
 * it is handed to them rather than each call site defaulting `spec.type` again.
 */
function drawCharts<T extends ChartSpecBase>(
  g: ChartGroup<T>,
  labels: string[],
  datasets: (spec: T, type: string) => any[],
): void {
  for (const spec of g.specs) {
    const type = spec.type ?? 'line';
    mkChart(g.id(spec), type, { labels, datasets: datasets(spec, type) }, spec.opts);
  }
}

/** Tear the group's charts down — what a view does when it has no data to show. */
function clearCharts<T extends ChartSpecBase>(g: ChartGroup<T>): void {
  for (const spec of g.specs) destroyChart(g.id(spec));
}

/**
 * One dataset in a chart that can be drawn either way: a translucent bar, or a
 * line with the shared styling (which `extra` overrides). Every chart on the
 * page picks between the two forms per metric, and each spelled the same
 * ternary out.
 *
 * A line asking to be filled (`extra.fill`) is washed with its OWN colour: the
 * four filled series each restated the line's hex a second time as an
 * `'#rrggbb11'` background, so a recoloured series left its fill behind.
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
        backgroundColor: extra.fill ? `${color}11` : 'transparent',
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

/**
 * `[1 … n]` — the ascending slot numbers the numbered pickers and the
 * year-over-year x-axes are built from. Three sites each wrote the same list
 * their own way: two spelled out `Array.from({ length: n }, (_, i) => i + 1)`
 * and the third gave the seven weekdays as a literal, so a one-based count read
 * as index arithmetic in one place and as data in another. (Named `oneTo`
 * rather than `range` — this page already has a Range period meaning a window
 * of dates.)
 */
const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

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
 * What a control strip's pickers currently hold, in document order — the one
 * thing a view needs from the controls it just rendered into `emptyEl`. The
 * dashboard and the year-over-year view each read their own strip back, and
 * each spelled the same `Array.from(…querySelectorAll('select'))` out; one of
 * them then took the values and the other passed the elements on, so the two
 * `url`/`query` builders took different arguments for the same job.
 */
const pickerValues = (id: string): string[] =>
  Array.from(el(id).querySelectorAll('select')).map(s => s.value);

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
 * Fill a table card rendered by `renderTableCard`: one `<th>` per header label,
 * then one row per item. The `-head` / `-body` ids pairing the two halves with
 * their card were spelled out at eight call sites, and because each half was
 * filled by its own function the three tables set their headers three different
 * ways — two of them once at startup, far from the rows they label.
 */
function fillTable<T>(
  id: string,
  head: readonly (string | number)[],
  items: readonly T[],
  row: (item: T) => string,
): void {
  renderList(`${id}-head`, head, l => th(l));
  renderList(`${id}-body`, items, row);
}

/** Empty a table card — its header along with its rows. */
const clearTable = (id: string): void => fillTable(id, [], [], () => '');

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

/**
 * An `/api/…` URL with its query string. Seven call sites each built their own
 * by interpolating values straight into a `?a=${…}&b=${…}` template, so none of
 * them encoded anything and the parameter names sat in string literals.
 */
type Params = Record<string, string | number | undefined>;

const api = (path: string, params: Params): string =>
  `/api/${path}?` +
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v ?? '')}`)
    .join('&');

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
  node.append(...children);
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
 * Build one of the numbered pickers the dashboard and the year-over-year view
 * share: options numbered 1..`count` labelled by `label`, pre-selected to the
 * reference date's own value for that unit (so a fresh load lands on populated
 * data — see `refDate`).
 *
 * The option list is built here, once — the calendar doesn't change — rather
 * than on every render. Each picker used to declare its list and its default
 * separately, so the two halves of one picker sat apart and a default could end
 * up naming a value its own list didn't offer.
 */
function numberedSelect(count: number, label: (n: number) => string, of: (d: Date) => number) {
  const options = oneTo(count).map(n => ({ value: String(n), label: label(n) }));
  return (onChange: () => void) => mkSelect(options, String(of(refDate())), onChange);
}

const weekSelect = numberedSelect(53, n => `Week ${n}`, isoWeek);
const monthSelect = numberedSelect(12, n => MONTH_NAMES[n - 1], d => d.getMonth() + 1);
const daySelect = numberedSelect(31, String, d => d.getDate());

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
  controls: (el: HTMLElement) => void;
  /** Those pickers' values → this period's API call. */
  url: (vals: string[]) => string;
}

/**
 * A picker over every date the data holds, defaulting to the newest — the Day
 * period's one selector, and the Range period's "To". Range's "From" is the
 * same picker with an earlier default, so all three now say `dateSelect` rather
 * than restating the option list and the `last(allDates)` default per site
 * (which is exactly why `weekSelect`/`monthSelect`/`daySelect` above exist).
 *
 * It reads `allDates` itself, the way `yearSelect` and the Range period's own
 * `url` already do. Handing the pool to `controls` instead meant a parameter
 * that was only ever the very global those two read directly, so the same list
 * reached the pickers by two routes.
 */
const dateSelect = (onChange: () => void, selected = last(allDates)) =>
  mkSelect(asOptions(allDates), selected, onChange);

const PERIODS = {
  day: {
    label: 'Day',
    controls: el => el.append(dateSelect(load)),
    url: v => api('day', { date: v[0] }),
  },

  week: {
    label: 'Week',
    controls: el => el.append(yearSelect(load), weekSelect(load)),
    url: v => api('week', { year: v[0], week: v[1] }),
  },

  month: {
    label: 'Month',
    controls: el => el.append(yearSelect(load), monthSelect(load)),
    url: v => api('month', { year: v[0], month: v[1] }),
  },

  year: {
    label: 'Year',
    controls: el => el.append(yearSelect(load)),
    url: v => api('year', { year: v[0] }),
  },

  range: {
    label: 'Range',
    // Two date pickers populated ONLY from dates that exist in the data,
    // so the user can never select a window outside the recorded range.
    // From defaults to the last ~30 available days for a sensible window.
    controls: el => {
      const fromSel = dateSelect(load, allDates[Math.max(0, allDates.length - 30)]);
      const toSel = dateSelect(load);

      // "All" checkbox — when checked, span the entire dataset and disable the
      // From/To pickers since the window is no longer user-controlled. The
      // strip is rebuilt from scratch here, so the flag starts off with it.
      rangeAll = false;
      const allChk = mkEl('input', { type: 'checkbox', className: 'form-check-input mt-0' });
      const allWrap = mkEl(
        'label',
        { className: 'text-muted small d-flex align-items-center gap-1 mb-0' },
        [allChk, 'All'],
      );
      allChk.addEventListener('change', () => {
        rangeAll = allChk.checked;
        fromSel.disabled = rangeAll;
        toSel.disabled = rangeAll;
        load();
      });

      el.append(allWrap, mutedLabel('From'), fromSel, mutedLabel('To'), toSel);
    },
    url: v => {
      let [from, to] = rangeAll && allDates.length
        ? [allDates[0], last(allDates)]                  // whole dataset
        : [v[0], v[1]];
      if (from && to && from > to) [from, to] = [to, from]; // tolerate reversed picks
      return api('range', { from, to });
    },
  },
} satisfies Record<string, PeriodSpec>;

type Period = keyof typeof PERIODS;

// --- State ---
let period: Period = 'week';
/** Every date the data holds, ascending — the pool every picker draws from. */
let allDates: string[] = [];
let lastRows: WeatherRow[] = [];   // rows from the most recent dashboard load (drives Compare range)
/**
 * Whether the Range period's "All" box is ticked. Held here because the box is
 * the one control that isn't a picker `pickerValues` can read back: its handler
 * used to leave the answer in the DOM under an id, which `url` then dug out
 * again with `document.getElementById` and a cast — the only place left that
 * reached for an element the page owns by any route other than `el`.
 */
let rangeAll = false;

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
  PERIODS[period].controls(emptyEl('controls'));
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
  let data: { rows: WeatherRow[]; stats: Stats };
  try {
    const url = PERIODS[period].url(pickerValues('controls'));
    data = await fetchJson<{ rows: WeatherRow[]; stats: Stats }>(url);
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
    if (!last_import) {
      stamp.textContent = 'Not yet imported';
      return;
    }
    const when = new Date(last_import);
    stamp.textContent = `Imported ${when.toLocaleString()} · ${records} records`;
    stamp.title = `Last import: ${when.toString()}`;
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

// Every key a card's group carries has a span on the card — the headline's, or
// one of the sub-line's — so each id below is one `renderStatCards` just wrote.
function renderStats(s: Stats | undefined): void {
  if (!s) return;
  for (const c of STAT_CARDS) {
    for (const [key, value] of Object.entries(c.pick(s))) {
      el(statId(c.prefix, key)).textContent = statText(c, key, value);
    }
  }
}

// --- The dashboard charts ---
// One entry per chart: its canvas (`chart-<key>`), its toggle-button label, its
// grid cell, and how to turn a period's rows into datasets. The card markup,
// the toggles and the rendering all walk this list, so a chart can't end up
// drawn but untoggleable, or toggleable with no card to hide (both were
// possible while the cards lived in index.html). Each can be toggled off, which
// removes its whole grid column so the rest reflow to fill the row; the choice
// persists in localStorage.
interface ChartSpec extends ChartSpecBase {
  key: string;
  label: string;
  /** Appended to the label for the card heading: "Humidity (%)". */
  unit: string;
  /** One entry per plotted series: which measure it reads, and how it looks.
      `col`/`height` come from ChartSpecBase: only the two charts that break the
      grid's default cell size give their own. */
  series: { label: string; field: Measure; color: string; extra?: any }[];
}

/** A stored measure a dashboard series can plot. */
type Measure = Exclude<keyof WeatherRow, 'date'>;

const CHART_META: ChartSpec[] = [
  {
    key: 'temp', label: 'Temperature', unit: '°C', col: 'col-12 col-xl-8', height: 110,
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
    key: 'hum', label: 'Humidity', unit: '%',
    series: [
      { label: 'High', field: 'hum_high', color: '#f87272', extra: { fill: true } },
      { label: 'Avg',  field: 'hum_avg',  color: '#facc15' },
      { label: 'Low',  field: 'hum_low',  color: '#60a5fa', extra: { fill: true } },
    ],
    // Humidity is a percentage, so pin the axis rather than letting it autoscale.
    opts: { scales: { y: { min: 0, max: 100 } } },
  },
  {
    key: 'pres', label: 'Pressure', unit: 'hPa',
    series: [
      { label: 'High', field: 'pres_high', color: '#a78bfa' },
      { label: 'Low',  field: 'pres_low',  color: '#818cf8', extra: { fill: true } },
    ],
  },
  {
    key: 'wind', label: 'Wind', unit: 'km/h',
    series: [
      { label: 'High', field: 'wind_high', color: '#fb923c', extra: { fill: true } },
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
 * canvas outright; only these are derived from the key.
 */
const chartId = (key: string) => `chart-${key}`;

/** The dashboard's charts: the only group whose cards can be toggled off. */
const DASHBOARD_CHARTS: ChartGroup<ChartSpec> = {
  container: 'chart-cards',
  specs: CHART_META,
  id: c => chartId(c.key),
  title: c => `${c.label} (${c.unit})`,
  col: 'col-12 col-md-6 col-xl-4',
  height: 120,
  toggleKey: c => c.key,
};

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

// --- Charts ---
function labels(rows: WeatherRow[]): string[] {
  return rows.map(r => r.date.slice(5)); // MM-DD
}

function renderCharts(rows: WeatherRow[]): void {
  drawCharts(DASHBOARD_CHARTS, labels(rows), (c, type) =>
    c.series.map(s => series(type, s.label, rows.map(r => r[s.field]), s.color, s.extra)));
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

function renderTable(rows: WeatherRow[]): void {
  fillTable('data-table', TABLE_COLUMNS.map(c => c.label), rows, r =>
    tr(TABLE_COLUMNS.map(c => td(c.cell(r), typeof c.cls === 'function' ? c.cls(r) : c.cls))),
  );
}

function clearAll(): void {
  clearCharts(DASHBOARD_CHARTS);
  clearTable('data-table');
}

// --- Import button ---
const importBtn = el('btn-import') as HTMLButtonElement;
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
interface CompareSpec extends ChartSpecBase {
  id: string;
  key: SharedKey;
  /** Suffix on the chart's series names ("Me · High"); bar charts use none. */
  series?: string;
  /** Heading on the chart card. */
  title: string;
  row: string;
}

const COMPARE_META: CompareSpec[] = [
  { id: 'cmp-temp-high', key: 'temp_high', series: 'High',
    title: 'Temperature High (°C)', row: 'Temp High (°C)' },
  { id: 'cmp-temp-low',  key: 'temp_low',  series: 'Low',
    title: 'Temperature Low (°C)',  row: 'Temp Low (°C)' },
  { id: 'cmp-precip',    key: 'precip',    type: 'bar',
    title: 'Precipitation (mm)',    row: 'Precip (mm)' },
  { id: 'cmp-wind',      key: 'wind_high', series: 'Wind',
    title: 'Wind Max (km/h)',       row: 'Wind Max (km/h)' },
];

const COMPARE_CHARTS: ChartGroup<CompareSpec> = {
  container: 'cmp-chart-cards',
  specs: COMPARE_META,
  id: m => m.id,
  title: m => m.title,
  col: 'col-12 col-xl-6',
  height: 110,
};

/**
 * One side of the Compare view: my station, and the public service it is
 * measured against. Each side used to be spelled out at every point that draws
 * it — its chart series, its summary column and that column's heading — so the
 * pair, and the order the difference between them is taken in, lived in three
 * places rather than one, and the public side was named four times over.
 */
interface CompareSide {
  /** Series name on the charts; a line appends its measure ("Me · High"). */
  name: string;
  /** Heading over this side's summary column. */
  head: string;
  color: string;
  /** Extra Chart.js styling — only the public series is dashed. */
  extra?: any;
  /** This side's values for one measure, on my dates. */
  values: (key: SharedKey) => (number | null)[];
}

/**
 * A figure's table cell, or an em dash where there is no figure. Every number
 * in both comparison tables is missing-tolerant, and the em-dash rule was
 * written once for the compared columns and again inside the delta cell — so
 * "no figure" had two spellings a row apart.
 */
const numCell = (v: number | null, fmt: (n: number) => string, cls = ''): string =>
  td(v == null ? '—' : fmt(v), cls);

/**
 * A signed-difference table cell — warm when it rose, cool when it fell, "—"
 * when either side is missing. Both comparison tables (mine-vs-public and
 * year-over-year) render their delta column this way.
 */
const diffClass = (diff: number | null): string =>
  !diff ? '' : diff > 0 ? 'text-danger' : 'text-info';

const deltaCell = (diff: number | null, fmt: (n: number) => string): string =>
  numCell(diff, n => `${n > 0 ? '+' : ''}${fmt(n)}`, diffClass(diff));

/**
 * A comparison summary table: one row per metric, one column per thing being
 * compared, and a trailing signed difference between the first column and the
 * last. Both comparison views are exactly this — mine-vs-Baar over two columns,
 * year-over-year over one per year — and each spelled out the same header
 * assembly, the same row assembly, the same em dash for a missing figure and the
 * same "only when both ends are there" guard around its difference.
 *
 * `delta.of` is the caller's because the two take the difference in opposite
 * directions (mine − theirs; latest − earliest) and only one of them rounds;
 * it is handed both ends already known to be present, which is the part that
 * was written twice.
 */
function renderDeltaTable<T>(
  id: string,
  o: {
    /** Heading over each compared column, in order. */
    columns: (string | number)[];
    metrics: readonly T[];
    label: (m: T) => string;
    /** This metric's value per column; null where a column has no figure. */
    values: (m: T) => (number | null)[];
    /** How this metric's numbers read — the unit differs per row in one view. */
    format: (m: T) => (n: number) => string;
    /** The difference column, or null when there is nothing to compare against. */
    delta: { head: string; of: (first: number, latest: number) => number } | null;
  },
): void {
  const { delta } = o;
  fillTable(
    id,
    ['Metric', ...o.columns, ...(delta ? [delta.head] : [])],
    o.metrics,
    m => {
      const values = o.values(m);
      const fmt = o.format(m);
      const first = values[0];
      const latest = last(values);
      const diff = delta && first != null && latest != null ? delta.of(first, latest) : null;
      return tr([
        td(o.label(m)),
        ...values.map(v => numCell(v, fmt)),
        ...(delta ? [deltaCell(diff, fmt)] : []),
      ]);
    },
  );
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
 *
 * It takes the status element rather than its id because both overlays write to
 * that line themselves as well — for a guard, or for the "only one year" remark
 * — so each named the same id twice and looked it up twice over.
 */
async function loadInto<T>(
  status: HTMLElement, url: string, loading: string, failure: string,
): Promise<T | null> {
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
  const status = el('cmp-status');
  if (!lastRows.length) {
    status.textContent = 'No local data selected — pick a period on the dashboard first.';
    return;
  }
  const from = lastRows[0].date;
  const to = last(lastRows)!.date;
  el('cmp-range').textContent = `${from} → ${to}`;

  const data = await loadInto<{ mine: WeatherRow[]; public: PublicRow[] }>(
    status, api('compare', { from, to }),
    'Loading public data…', 'Could not fetch public data',
  );
  if (!data) return;

  // Align public rows to my dates so both series share the same x-axis.
  const pub = new Map<string, PublicRow>(data.public.map(p => [p.date, p]));
  const sides: CompareSide[] = [
    { name: 'Me', head: 'My avg', color: '#38bdf8', values: key => lastRows.map(r => r[key]) },
    {
      name: 'Baar', head: 'Baar avg', color: '#fb923c', extra: { borderDash: [5, 3] },
      values: key => lastRows.map(r => pub.get(r.date)?.[key] ?? null),
    },
  ];

  // Lines name their measure ("Me · High"); the bar chart has only one.
  drawCharts(COMPARE_CHARTS, labels(lastRows), (m, type) =>
    sides.map(s =>
      series(type, `${s.name}${m.series ? ` · ${m.series}` : ''}`, s.values(m.key), s.color, s.extra),
    ));

  renderCompareSummary(sides);
}

function renderCompareSummary(sides: CompareSide[]): void {
  const avg = (vals: (number | null)[]): number | null => {
    const v = vals.filter((x): x is number => x != null && !Number.isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  // One decimal throughout — every measure compared here is a plain reading.
  const one = (n: number) => n.toFixed(1);

  renderDeltaTable('cmp-summary', {
    columns: sides.map(s => s.head),
    metrics: COMPARE_META,
    label: m => m.row,
    values: m => sides.map(s => avg(s.values(m.key))),
    format: () => one,
    delta: { head: 'Difference', of: (mine, theirs) => mine - theirs },
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
  /** Those pickers' values → this unit's /api/across-years params. The `unit`
      param itself comes from the entry's own key, so it isn't restated here. */
  query: (vals: string[]) => Params;
  /** The row's slot inside its period, so the same slot lines up across years. */
  pos: (r: WeatherRow) => number;
  /** The shared x-axis for this unit: slot positions and their labels. */
  axis: (label: string) => { positions: number[]; labels: string[] };
}

const YOY_UNITS = {
  day: {
    label: 'Day',
    controls: el => el.append(monthSelect(loadYoy), daySelect(loadYoy)),
    query: v => ({ month: v[0], day: v[1] }),
    pos: () => 1,                                        // a single slot
    axis: label => ({ positions: [1], labels: [label] }),
  },

  week: {
    label: 'Week',
    controls: el => el.append(weekSelect(loadYoy)),
    query: v => ({ week: v[0] }),
    pos: r => localDate(r.date).getDay() || 7,           // Mon=1..Sun=7
    axis: () => ({
      positions: oneTo(7),
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    }),
  },

  month: {
    label: 'Month',
    controls: el => el.append(monthSelect(loadYoy)),
    query: v => ({ month: v[0] }),
    pos: r => Number(r.date.slice(8, 10)),               // day of month, 1..31
    axis: () => {
      const positions = oneTo(31);
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
interface YoyMetric extends ChartSpecBase { id: string; title: string; get: (r: WeatherRow) => number; }
const YOY_METRICS: YoyMetric[] = [
  { id: 'yoy-temp-avg',  title: 'Temp Avg (°C)',      get: r => r.temp_avg },
  { id: 'yoy-temp-high', title: 'Temp High (°C)',     get: r => r.temp_high },
  { id: 'yoy-temp-low',  title: 'Temp Low (°C)',      get: r => r.temp_low },
  { id: 'yoy-hum-avg',   title: 'Humidity Avg (%)',   get: r => r.hum_avg },
  { id: 'yoy-wind-high', title: 'Wind Max (km/h)',    get: r => r.wind_high },
  { id: 'yoy-pres-avg',  title: 'Pressure Avg (hPa)', get: r => (r.pres_high + r.pres_low) / 2 },
  { id: 'yoy-precip',    title: 'Precipitation (mm)', type: 'bar', get: r => r.precip },
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

const YOY_CHARTS: ChartGroup<YoyMetric> = {
  container: 'yoy-chart-cards',
  specs: YOY_METRICS,
  id: m => m.id,
  title: m => m.title,
  col: 'col-12 col-md-6 col-xl-4',
  height: 120,
};

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
  const vals = pickerValues('yoy-controls').slice(1);   // [0] is the unit selector
  return api('across-years', { unit: yoyUnit, ...YOY_UNITS[yoyUnit].query(vals) });
}

async function loadYoy(): Promise<void> {
  const status = el('yoy-status');
  const data = await loadInto<YoyResponse>(status, yoyUrl(), 'Loading…', 'Could not load');
  if (!data) return;

  el('yoy-heading').textContent = `${data.label} across years`;
  if (!data.years.length) {
    status.textContent = 'No data for this period.';
    clearCharts(YOY_CHARTS);
    clearTable('yoy-summary');
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

  drawCharts(YOY_CHARTS, xlabels, (metric, type) =>
    data.years.map((yb, i) =>
      series(
        type,
        String(yb.year),
        positions.map(p => { const row = byPos[i].get(p); return row ? metric.get(row) : null; }),
        yearColor(i),
      )));

  renderYoySummary(data);
}

function renderYoySummary(data: YoyResponse): void {
  const round = (v: number) => Math.round(v * 10) / 10;

  renderDeltaTable('yoy-summary', {
    columns: data.years.map(y => y.year),
    metrics: YOY_SUMMARY,
    label: m => m.label,
    // A row names the stat card it reads, so both the accessor and the unit come
    // from STAT_CARDS rather than being restated here.
    values: m => data.years.map(y => CARD_BY_PREFIX[m.prefix].pick(y.stats)[m.key]),
    format: m => v => statText(CARD_BY_PREFIX[m.prefix], m.key, v),
    // With ≥2 years, a trailing column shows the change from the earliest to the
    // latest year — the headline "how did this period differ" number.
    delta:
      data.years.length >= 2
        ? {
            head: 'Δ latest−earliest',
            of: (earliest, latest) => round(latest - earliest),
          }
        : null,
  });
}

// --- Init ---
(async () => {
  renderPeriodTabs();
  renderStatCards();
  renderChartGroup(DASHBOARD_CHARTS);
  renderChartGroup(COMPARE_CHARTS);
  renderChartGroup(YOY_CHARTS);
  renderTableCard('data-table', true);
  renderTableCard('cmp-summary');
  renderTableCard('yoy-summary');
  // Each table's header is filled alongside its rows, by whatever renders them.
  renderChartToggles();
  applyChartVisibility();   // apply persisted hidden state immediately, even before charts render
  await reloadDates();
})();
