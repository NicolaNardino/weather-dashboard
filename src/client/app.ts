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
  precip: { total: number; max: number };
  rain: { days: number; dry: number; pct: number };
  climate: { frost: number; ice: number; summer: number; hot: number };
  spells: { wet: Spell; dry: Spell };
}

/** A run of consecutive days; `from`/`to` are null when no day qualified. */
interface Spell { days: number; from: string | null; to: string | null }

interface PublicRow {
  date: string;
  temp_high: number | null;
  temp_low: number | null;
  wind_high: number | null;
  precip: number | null;
}

/** A stored measure — every column of a row but the date it is keyed by. */
type Measure = Exclude<keyof WeatherRow, 'date'>;

/** The measures both my rows and the public ones carry — the Compare axis. */
type SharedKey = Measure & keyof PublicRow;

/**
 * The chart chrome: the three greys a chart's legend, its tick labels and its
 * grid lines are drawn in, as opposed to the plotted HUEs further down. Each was
 * a literal where it was used — the tick grey and the grid grey twice over, once
 * per axis, and the grid grey again in the year-to-date chart's own grid
 * callback — so five literals said three things and recolouring the chrome meant
 * finding every axis that happened to mention it.
 */
const CHROME = { legend: '#aaa', tick: '#888', grid: '#333' } as const;

const CHART_DEFAULTS = {
  responsive: true,
  animation: false,
  plugins: { legend: { labels: { color: CHROME.legend, boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: {
      ticks: { color: CHROME.tick, maxRotation: 45, font: { size: 10 } },
      grid: { color: CHROME.grid },
    },
    y: { ticks: { color: CHROME.tick, font: { size: 10 } }, grid: { color: CHROME.grid } },
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
 * it is drawn, and optionally its own card geometry where that differs from its
 * view's.
 */
interface ChartSpecBase {
  /** Chart.js type. Every chart here is a line unless it says otherwise, so
      only the two bar charts carry one — thirteen specs across the three lists
      restated `type: 'line'`, and `drawCharts` now resolves the default once. */
  type?: string;
  /** Chart-specific option overrides merged over CHART_DEFAULTS. */
  opts?: any;
  /** Overrides the view's column classes / canvas height for this chart. */
  col?: string;
  height?: number;
}

/**
 * A view as one thing: its charts — where their cards go, how a spec names and
 * titles its canvas, the cell geometry they share — and the one table sitting
 * under them.
 *
 * The three views (the dashboard, Compare and Across Years) each used to
 * restate that at every point which touched them: a card renderer, a
 * `drawCharts` call and a teardown loop all named the same canvas their own
 * way, and the three card renderers were the same `renderList(container,
 * specs, chartCard(…))` written out three times.
 *
 * The table came in last and stayed outside, so each view's table id went on
 * being spelled out as a literal at the two or three places that touch it —
 * built at startup here, filled by whatever renders its rows there, emptied in
 * a third — and "empty this view" was a pair of calls, tearing the charts down
 * and then clearing the table, written out per view with nothing tying the two
 * halves together.
 */
interface View<T extends ChartSpecBase> {
  /** The view's own element in the markup; `view()` names the two halves below. */
  root: string;
  /** Container the chart cards are rendered into: `<root>-charts`. */
  container: string;
  specs: readonly T[];
  /** This spec's canvas id. */
  id: (spec: T) => string;
  /** Heading on this spec's card. */
  title: (spec: T) => string;
  /** Card geometry for the view; a spec's own `col`/`height` wins. */
  col: string;
  height: number;
  /** The view's one table card: `<root>-table`. */
  table: string;
  /** Row highlighting — only the dashboard's long data table wants it. */
  tableHover?: boolean;
  /**
   * Tag each column with the `data-chart` attribute `applyChartVisibility()`
   * hides it by. Only the dashboard's charts can be toggled off.
   */
  toggleKey?: (spec: T) => string;
}

/**
 * A view, with the ids of its two halves derived from its own root element.
 *
 * Those two containers were hand-written in index.html — a chart row carrying
 * `row g-3 mb-3` and a table div — so each view's pair of ids was spelled out
 * once there and again here, and the grid classes on the row were restated per
 * view. index.html now declares one empty div per view and this names the
 * halves inside it, which is the same move the cards themselves already made.
 */
function view<T extends ChartSpecBase>(
  root: string,
  rest: Omit<View<T>, 'root' | 'container' | 'table'>,
): View<T> {
  return { ...rest, root, container: `${root}-charts`, table: `${root}-table` };
}

/** Build the view's empty shell: one card per chart, then its table card. */
function renderView<T extends ChartSpecBase>(v: View<T>): void {
  setHtml(
    v.root,
    `<div class="row g-3 mb-3" id="${v.container}"></div><div id="${v.table}"></div>`,
  );
  renderList(v.container, v.specs, spec =>
    chartCard({
      id: v.id(spec),
      title: v.title(spec),
      col: spec.col ?? v.col,
      height: spec.height ?? v.height,
      chartKey: v.toggleKey?.(spec),
    }));
  renderTableCard(v.table, v.tableHover);
}

/**
 * Draw one chart per spec in the view onto a shared x-axis. The views differ
 * only in how a spec becomes datasets — which need the resolved chart type, so
 * it is handed to them rather than each call site defaulting `spec.type` again.
 */
function drawCharts<T extends ChartSpecBase>(
  v: View<T>,
  labels: string[],
  datasets: (spec: T, type: string) => any[],
): void {
  for (const spec of v.specs) {
    const type = spec.type ?? 'line';
    mkChart(v.id(spec), type, { labels, datasets: datasets(spec, type) }, spec.opts);
  }
}

/** Empty the view — charts and table alike — when it has no data to show. */
function clearView<T extends ChartSpecBase>(v: View<T>): void {
  for (const spec of v.specs) destroyChart(v.id(spec));
  clearTable(v.table);
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

/**
 * The arithmetic mean of a list. The heatmap's diverging scale pivots on it and
 * the Compare summary averages each column with it, and each spelled out the
 * same `reduce((a, b) => a + b, 0) / length`.
 */
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** One decimal place — how every figure the two summaries and the heatmap
    legend print is rounded, written out as `Math.round(v * 10) / 10` at each. */
const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * "3 days" / "1 day" — a count with its noun agreeing. Four places on the page
 * say how many days something lasted (the spell text, both coverage messages
 * and the stat cards that report a count of days) and each carried its own
 * `n === 1` test.
 */
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

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
 * The `<select>` pickers inside a node, in document order. Two places ask a
 * control strip for them — the readback below, and the Range period's "All"
 * box, which disables the window it has taken over — and each spelled out the
 * same `Array.from(…querySelectorAll('select'))`, so the one thing that makes a
 * node a strip was asserted twice.
 */
const selectsIn = (node: ParentNode): HTMLSelectElement[] =>
  Array.from(node.querySelectorAll('select'));

/**
 * What a control strip's pickers currently hold, in document order — the one
 * thing a view needs from the controls it just rendered into `emptyEl`. The
 * dashboard and the year-over-year view each read their own strip back; one of
 * them then took the values and the other passed the elements on, so the two
 * `url`/`query` builders took different arguments for the same job.
 */
const pickerValues = (id: string): string[] => selectsIn(el(id)).map(s => s.value);

/**
 * Table markup. Every table on the page — the dashboard's data table and the
 * two comparison summaries — built its own `<td class="…">` / `<th>` / `<tr>`
 * strings, so the class attribute was spelled out even when empty in one place
 * and omitted in another. One cell builder covers all six sites.
 */
const cell = (tag: 'td' | 'th', content: string | number, cls = ''): string =>
  `<${tag}${cls ? ` class="${cls}"` : ''}>${content}</${tag}>`;
const td = (content: string | number, cls = '') => cell('td', content, cls);
// Headers carry no class anywhere on the page, so `th` doesn't offer one.
const th = (content: string | number) => cell('th', content);
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

/**
 * The parts of a stored `YYYY-MM-DD` day, named.
 *
 * Every date on this page is one of those strings, and eight places cut a piece
 * out of one by character position — `slice(0, 4)` for the year picker's pool,
 * `slice(0, 7)` for the month a calendar row is, `slice(5)` for the chart
 * labels, `slice(8, 10)` for a day's slot in its month, and two more
 * (`slice(0, 2)`, `slice(3)`) for the halves of an `MM-DD` key. Each asserts the
 * layout of a stored date again, and says where to cut rather than what is
 * being cut out.
 */
const yearOf = (iso: string): string => iso.slice(0, 4);
const monthOf = (iso: string): string => iso.slice(0, 7);
/** The `MM-DD` of a day — the within-year key the year-over-year views share. */
const mdOf = (iso: string): string => iso.slice(5);
/** The day of the month, as a number: "2026-04-07" → 7. */
const dayOf = (iso: string): number => Number(iso.slice(8, 10));
/** The two parts of an `MM-DD` key, as numbers: "09-27" → 9 and 27. */
const mdMonthNo = (md: string): number => Number(md.slice(0, 2));
const mdDayNo = (md: string): number => Number(md.slice(3));

/**
 * A stored day as its UTC-midnight instant, and an instant back as a day — the
 * pair every step along the calendar here goes through, and the one `nextDay`
 * below is the whole of. UTC on purpose, as in `src/dates.ts` on the server
 * side: stepping a day in local time repeats a date across a DST boundary.
 *
 * `MS_PER_DAY` is also the week number's divisor, which had the same 86 400 000
 * written out as a bare literal — the only other place on this page that
 * measures a span in days.
 */
const MS_PER_DAY = 86_400_000;
const utcMs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The `YYYY-MM-DD` day after `iso`, in UTC — what makes two dates consecutive,
 * and the single step `datesIn` below walks a calendar unit's days with.
 *
 * It was one day's worth of a general `dayPlus(iso, days)`, because the two
 * callers stepped by different distances: the coverage runs by a day, and the
 * year-to-date axis by an index, to count 366 of them off 1 January. With that
 * axis walked rather than counted, a day is the only distance this page moves.
 */
const nextDay = (iso: string): string => isoDay(utcMs(iso) + MS_PER_DAY);

/**
 * Every day of the calendar unit a key names — a `YYYY-MM` month, or a `YYYY`
 * year. The key IS the prefix its days share, so the walk opens on the first of
 * them and runs for as long as a day still carries it.
 *
 * Both lists of calendar slots on this page are that walk, and each supplied
 * its own first day and its own test for where the run ends: the heatmap's
 * month row bolted `-01` onto the key it holds and compared `monthOf` back
 * against it, the year-to-date axis opened on a literal '2024-01-01' and
 * compared `yearOf` against a second copy of that year. Before either, both
 * counted their own length off instead — the month row from
 * `new Date(y, mo, 0).getDate()`, the one piece of calendar arithmetic here
 * done in local time, and the axis from a bare 366, which re-derives that a
 * leap year is that long.
 */
function datesIn(key: string): string[] {
  const days: string[] = [];
  for (let day = `${key}-01-01`.slice(0, 10); day.startsWith(key); day = nextDay(day)) {
    days.push(day);
  }
  return days;
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

/**
 * A picker over a pool of plain strings, defaulting to the newest — every date
 * the data holds, or every year it spans. Both pickers below spelled the same
 * value-is-its-own-label mapping and the same `last(pool)` default out, and one
 * of them then restated its empty-pool fallback a second time as the default it
 * had just put in the list.
 */
const poolSelect = (pool: string[], onChange: () => void, selected = last(pool)) =>
  mkSelect(pool.map(v => ({ value: v, label: v })), selected, onChange);

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * "Mar" for 3. Four places named a month and each indexed MONTH_NAMES itself,
 * every one of them re-deriving that the list is 0-based and the month is not.
 */
const monthName = (month: number): string => MONTH_NAMES[month - 1];

/**
 * The month behind an `MM-DD` key: "09-27" → "Sep". The year-to-date chart
 * labels both its points and its month ticks from that key, and each parsed the
 * two-digit month out and shifted it for the list on its own.
 */
const mdMonth = (md: string): string => monthName(mdMonthNo(md));

/** Whether an `MM-DD` key is the first of its month — where the year-to-date
    axis puts a tick, and the only place it draws a grid line. */
const isMonthStart = (md: string | undefined): boolean => !!md?.endsWith('-01');

/**
 * The days of a week, Monday first — the labels on the Across-Years week axis,
 * and, through their count, its slot numbers (which that unit's `pos` numbers
 * Mon=1..Sun=7 to match). The two halves were a seven-item literal beside a
 * separate `oneTo(7)`, so a week was seven days twice over with nothing
 * holding the parallel lists the same length. MONTH_DAYS below is the same
 * list for a month, which the month axis already labels from.
 */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Every day number a month can have, 1..31.
 *
 * Three places said 31 for themselves — the day picker below, the calendar
 * heatmap's columns and the Across-Years month axis — each re-deciding that the
 * longest month is the one a day-of-month slot list has to cover. They are the
 * same list: a row of the heatmap IS a month, and the month axis plots a row
 * per year on the same slots.
 */
const MONTH_DAYS = oneTo(31);

/**
 * Build one of the numbered pickers the dashboard and the year-over-year view
 * share: one option per slot in `slots`, labelled by `label`, pre-selected to
 * the reference date's own value for that unit (so a fresh load lands on
 * populated data — see `refDate`).
 *
 * The option list is built here, once — the calendar doesn't change — rather
 * than on every render. Each picker used to declare its list and its default
 * separately, so the two halves of one picker sat apart and a default could end
 * up naming a value its own list didn't offer.
 */
function numberedSelect(slots: number[], label: (n: number) => string, of: (d: Date) => number) {
  const options = slots.map(n => ({ value: String(n), label: label(n) }));
  return (onChange: () => void) => mkSelect(options, String(of(refDate())), onChange);
}

const weekSelect = numberedSelect(oneTo(53), n => `Week ${n}`, isoWeek);
const monthSelect = numberedSelect(oneTo(12), monthName, d => d.getMonth() + 1);
const daySelect = numberedSelect(MONTH_DAYS, String, d => d.getDate());

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
 * One entry of a dispatch table keyed by what it selects — a dashboard period,
 * or a year-over-year comparison unit. `controls` populates a strip with that
 * entry's pickers; `params` turns whatever those pickers now hold into its
 * query. Keeping them together means the key is dispatched once rather than in
 * two `if/else` chains that had to stay in step — a new entry is one line, not
 * two branches in two places.
 *
 * Both tables below carry exactly this, and each used to spell the three
 * members out with the same explanation attached.
 */
interface ControlStrip {
  /** Text on the tab or option that picks this entry. */
  label: string;
  controls: (el: HTMLElement) => void;
  /** Those pickers' values → this entry's query params. */
  params: (vals: string[]) => Params;
}

/**
 * A control a strip is built from: it rebuilds itself around `onChange`. A
 * picker may contribute more than one node — the Range period's two date
 * pickers each sit behind a caption saying which end of the window it is.
 */
type Picker = (onChange: () => void) => HTMLElement | HTMLElement[];

/**
 * A dispatch table bound to the element its strip lives in: `render` fills that
 * element with the named entry's pickers, and `params` reads whatever those
 * pickers now hold back into that entry's query.
 *
 * Each of the two tables below is driven from two places — one that writes the
 * strip and one that reads it — and all four named the container themselves, so
 * the element a strip was rendered into and the one it was read back from were
 * separate literals that had to agree. That is the same pair `view()` already
 * stopped spelling out for a view's chart and table containers.
 */
function stripsIn<K extends string>(id: string, table: Record<K, ControlStrip>) {
  return {
    /**
     * The table's entries as `{ value, label }` pairs — the shape a picker over
     * them takes, and the one a tab strip that selects one reads. Both call
     * sites rebuilt this themselves from `Object.keys(table)`, each restating
     * the cast that a bare `Object.keys` loses the key type to, and each then
     * reaching back into the table a second time for the entry's own label.
     */
    options: (Object.keys(table) as K[]).map(value => ({ value, label: table[value].label })),
    render: (key: K): void => table[key].controls(emptyEl(id)),
    params: (key: K): Params => table[key].params(pickerValues(id)),
  };
}

/**
 * A control strip whose pickers ARE its query params: one ordered list of
 * `[param name, picker]` pairs drives both halves — rendering the strip, and
 * reading it back into the call.
 *
 * Every period/unit entry below spelled those halves out separately: `controls`
 * appended the pickers in one order and `params` read them back at hand-written
 * `v[0]` / `v[1]` positions, so the two had to agree with nothing checking that
 * they did. Adding a picker meant editing both, and inserting one anywhere but
 * the end silently re-labelled every param after it.
 */
function paramPickers(
  onChange: () => void,
  named: [string, Picker][],
): Omit<ControlStrip, 'label'> {
  return {
    controls: (el: HTMLElement) => el.append(...named.flatMap(([, picker]) => picker(onChange))),
    params: (vals: string[]): Params =>
      Object.fromEntries(named.map(([name], i) => [name, vals[i]])),
  };
}

/**
 * A picker with a dimmed caption in front of it. `pickerValues` reads a strip's
 * `<select>`s in document order, so a caption rides along with the picker it
 * names instead of being appended beside it.
 */
const captioned =
  (text: string, picker: (onChange: () => void) => HTMLElement): Picker =>
  onChange => [mutedLabel(text), picker(onChange)];

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
  poolSelect(allDates, onChange, selected);

/** Where the Range period opens: the last ~30 available days, a sensible window. */
const rangeStart = () => allDates[Math.max(0, allDates.length - 30)];

/**
 * The Range period's window: two date pickers populated ONLY from dates that
 * exist in the data, so the user can never select a window outside the recorded
 * range.
 *
 * Named out here so the entry below — the one strip that also carries a control
 * which is not a param — can still say its two params once, in the order the
 * pickers appear, rather than appending them itself and reading them back at
 * hand-written `v[0]` / `v[1]` positions.
 */
const RANGE_PICKERS = paramPickers(load, [
  ['from', captioned('From', onChange => dateSelect(onChange, rangeStart()))],
  ['to', captioned('To', dateSelect)],
]);

/**
 * One entry per period selector. Each key is also the `/api/<key>` route that
 * period loads — day, week, month, year and range are named the same on both
 * sides — so the endpoint comes from the entry's own key rather than a `path`
 * field restating it, the way `YOY_UNITS` below already takes its `unit` param.
 */
/**
 * A period picked within a year: the year selector, then the period's own
 * numbered one. Week and Month are both exactly that, and each spelled the
 * pair out — so the year picker that has to come first appeared twice, in a
 * list whose order silently names the params.
 */
const yearScoped = (name: string, picker: Picker) =>
  paramPickers(load, [
    ['year', yearSelect],
    [name, picker],
  ]);

const PERIODS = {
  day: { label: 'Day', ...paramPickers(load, [['date', dateSelect]]) },

  week: { label: 'Week', ...yearScoped('week', weekSelect) },

  month: { label: 'Month', ...yearScoped('month', monthSelect) },

  year: { label: 'Year', ...paramPickers(load, [['year', yearSelect]]) },

  range: {
    label: 'Range',
    controls: el => {
      // "All" checkbox — when checked, span the entire dataset and disable the
      // window's pickers, since it is no longer user-controlled. The strip is
      // rebuilt from scratch here, so the flag starts off with it.
      rangeAll = false;
      const allChk = mkEl('input', { type: 'checkbox', className: 'form-check-input mt-0' });
      allChk.addEventListener('change', () => {
        rangeAll = allChk.checked;
        for (const sel of selectsIn(el)) sel.disabled = rangeAll;
        load();
      });
      el.append(
        mkEl(
          'label',
          { className: 'text-muted small d-flex align-items-center gap-1 mb-0' },
          [allChk, 'All'],
        ),
      );
      RANGE_PICKERS.controls(el);
    },
    params: v => {
      const picked = RANGE_PICKERS.params(v) as { from?: string; to?: string };
      let [from, to] = rangeAll && allDates.length
        ? [allDates[0], last(allDates)]                  // whole dataset
        : [picked.from, picked.to];
      if (from && to && from > to) [from, to] = [to, from]; // tolerate reversed picks
      return { from, to };
    },
  },
} satisfies Record<string, ControlStrip>;

type Period = keyof typeof PERIODS;

/** The dashboard's own control strip — the navbar row beside the period tabs. */
const PERIOD_STRIP = stripsIn('controls', PERIODS);

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
  renderButtonGroup('period-tabs', PERIOD_STRIP.options, {
    label: o => o.label,
    active: o => o.value === period,
    each: (o, btn) => { btn.dataset.period = o.value; },   // the harness clicks these
    onClick: o => {
      period = o.value;
      showView('dashboard');    // period tabs belong to the dashboard
      renderControls();
      load();
    },
  });
}

// --- Controls ---
function renderControls(): void {
  PERIOD_STRIP.render(period);
}

function yearSelect(onChange: () => void): HTMLSelectElement {
  const thisYear = String(new Date().getFullYear());
  const years = [...new Set(allDates.map(yearOf))];
  return poolSelect(years.length ? years : [thisYear], onChange);
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
  return Math.ceil((diff / MS_PER_DAY + (jan4.getDay() || 7)) / 7);
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

/**
 * What every period route answers with — the rows in the period, the stat-card
 * figures over them, and how completely the period is recorded.
 *
 * Named, because the loader below had to declare its variable before the `try`
 * that fills it in order to use it after, and so wrote the shape out as that
 * declaration's type and then referred back to it as `typeof data`. The two
 * other things a loader on this page fetches (`Stats`, `Coverage`) are named
 * interfaces already; this is the one that holds them.
 */
interface PeriodData { rows: WeatherRow[]; stats: Stats; coverage: Coverage }

async function load(): Promise<void> {
  // The same fetch-or-null the two overlays' `loadInto` already does, so the
  // happy path reads straight down rather than out of a `try` that assigns to
  // a variable declared above it.
  const data = await fetchJson<PeriodData>(api(period, PERIOD_STRIP.params(period)))
    .catch(() => null);
  if (!data) {
    // A period the server has no data for (the day route 404s) — blank the
    // dashboard rather than leaving the previous period's rows on screen.
    lastRows = [];
    clearView(DASHBOARD_VIEW);
    renderCalendar([], []);
    renderCoverage(null);
    return;
  }

  lastRows = data.rows;
  renderStats(data.stats);
  renderCoverage(data.coverage);
  renderCalendar(data.rows, data.coverage.missing);
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
  /** Hover text for the whole card — a definition, or detail that doesn't fit. */
  hint?: (s: Stats) => string;
}

const HIGH_LOW: StatCard['sub'] = [{ key: 'low', after: ' / ' }, { key: 'high' }];

const STAT_CARDS: StatCard[] = [
  { prefix: 'temp', title: 'Temperature', pick: s => s.temp, unit: '°C',
    headline: 'avg', sub: HIGH_LOW },
  { prefix: 'dew', title: 'Dew Point', pick: s => s.dew, unit: '°C',
    headline: 'avg', sub: HIGH_LOW },
  { prefix: 'hum', title: 'Humidity', pick: s => s.humidity, unit: '%',
    headline: 'avg', sub: HIGH_LOW },
  { prefix: 'wind', title: 'Wind (max)', pick: s => s.wind, unit: 'km/h',
    headline: 'high', sub: [{ key: 'avg', before: 'avg ' }] },
  { prefix: 'pres', title: 'Pressure', pick: s => s.pressure, unit: 'hPa',
    headline: 'avg', sub: HIGH_LOW },
  { prefix: 'precip', title: 'Precipitation', pick: s => s.precip, unit: 'mm',
    headline: 'total', sub: [{ key: 'max', before: 'wettest day ' }] },
  // Rain days: a day with any precipitation. `pct` is of the days with data.
  { prefix: 'rain', title: 'Rain Days', pick: s => s.rain, unit: '%',
    headline: 'days', sub: [{ key: 'pct', after: ' of days · ' }, { key: 'dry', after: ' dry' }],
    bare: ['days', 'dry'] },
  // Spells are consecutive calendar days; a day missing from the record ends one.
  { prefix: 'spell', title: 'Longest Wet Spell', unit: 'days',
    pick: s => ({ wet: s.spells.wet.days, dry: s.spells.dry.days }),
    headline: 'wet', sub: [{ key: 'dry', before: 'longest dry ' }],
    hint: s => `Wet: ${spellText(s.spells.wet)}\nDry: ${spellText(s.spells.dry)}` },
  // The MeteoSwiss climate-day definitions, on the card's hover text.
  { prefix: 'frost', title: 'Frost Days', unit: 'days',
    pick: s => ({ frost: s.climate.frost, ice: s.climate.ice }),
    headline: 'frost', sub: [{ key: 'ice', after: ' ice days' }], bare: ['frost', 'ice'],
    hint: () => 'Frost day: low below 0 °C\nIce day: high below 0 °C' },
  { prefix: 'summer', title: 'Summer Days', unit: 'days',
    pick: s => ({ summer: s.climate.summer, hot: s.climate.hot }),
    headline: 'summer', sub: [{ key: 'hot', after: ' hot days' }], bare: ['summer', 'hot'],
    hint: () => 'Summer day: high of 25 °C or more\nHot day: high of 30 °C or more' },
];

/** "6 days, 2026-03-02 → 2026-03-07" — or "none" when no day qualified. */
const spellText = (sp: Spell): string =>
  sp.from ? `${plural(sp.days, 'day')}, ${sp.from} → ${sp.to}` : 'none';

/** The card a stats group belongs to, by prefix — how a metric finds its unit. */
const CARD_BY_PREFIX: Record<string, StatCard> = Object.fromEntries(
  STAT_CARDS.map(c => [c.prefix, c]),
);

/**
 * The unit a measure is reported in, named once — on the stat card that already
 * shows it. The three chart lists below each put that unit in their own
 * headings and each wrote the string out again, so '°C' appeared five times
 * across the file and 'km/h' four: recording a measure in different units
 * meant finding every heading that happened to mention it.
 *
 * A list says which card it reads, the way YOY_SUMMARY already does — by
 * `prefix` for the ones whose entries are derived measures, and by the entry's
 * own key where that key IS the prefix.
 */
const unitOf = (prefix: string): string => CARD_BY_PREFIX[prefix].unit;

/**
 * A heading with its measure's unit in parentheses — "Temp High (°C)". All
 * three views title their chart cards this way and the Compare view labels its
 * summary rows the same, and each wrote the parenthesised unit out itself. The
 * shape now sits beside `unitOf`, which the same comment above already explains
 * exists so a unit is named once rather than per heading.
 */
const withUnit = (text: string, prefix: string): string => `${text} (${unitOf(prefix)})`;

/**
 * A measure's value with its unit appended — a count (see `bare`) carries none.
 *
 * Named by the same prefix `unitOf` takes, rather than by a card handed in: the
 * two answer questions about the same card, and the caller that needed both
 * ended up reaching into CARD_BY_PREFIX itself to supply one of them.
 */
const statText = (prefix: string, key: string, value: number | string): string => {
  if (CARD_BY_PREFIX[prefix].bare?.includes(key)) return String(value);
  const unit = unitOf(prefix);
  // A count of days reads "1 day", not "1 days".
  return unit === 'days' ? plural(Number(value), 'day') : `${value} ${unit}`;
};

/** The stat-card prefix behind a stored measure: `temp_high` → `temp`. */
const prefixOf = (field: string): string => field.split('_')[0];

/**
 * Where one stat's value is written. `renderStatCards` puts this id on the
 * element and `renderStats` finds it again by the same name, so the template
 * has to agree across the two — it was spelled out three times (the headline,
 * the sub-line spans, and the lookup) with nothing tying them together.
 */
const statId = (prefix: string, key: string) => `s-${prefix}-${key}`;

/** A stat card's own column — where its `hint` hover text goes. Kept off the
    `s-` prefix, which the harness reads as "a value that must fill in". */
const statCardId = (prefix: string) => `card-${prefix}`;

const statSpan = (prefix: string, key: string) => `<span id="${statId(prefix, key)}">—</span>`;

function renderStatCards(): void {
  renderList('stat-cards', STAT_CARDS, c => `
    <div class="col" id="${statCardId(c.prefix)}">
      ${cardWell({
        cls: 'h-100',
        bodyCls: 'p-3',
        body: `<div class="text-muted small">${c.title}</div>
          <div class="fs-4 fw-bold text-nowrap" id="${statId(c.prefix, c.headline)}">—</div>
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
      el(statId(c.prefix, key)).textContent = statText(c.prefix, key, value);
    }
    if (c.hint) el(statCardId(c.prefix)).title = c.hint(s);
  }
}

/**
 * The plot palette, named once. The three chart lists below — the dashboard's
 * series, the two Compare sides and the year-over-year year colours — drew from
 * the same ten hues and each wrote its own hex out, so seven of the ten
 * appeared two or three times over and the page had no one place saying what
 * the palette is. Recolouring a hue meant finding every list that used it and
 * hoping none was missed.
 *
 * Named by hue rather than by role, because the same hue means different things
 * in different views: `orange` is the wind series on the dashboard and Baar on
 * the Compare view.
 */
const HUE = {
  red: '#f87272',
  orange: '#fb923c',
  peach: '#fdba74',
  amber: '#facc15',
  green: '#4ade80',
  blue: '#60a5fa',
  sky: '#38bdf8',
  indigo: '#818cf8',
  violet: '#a78bfa',
  pink: '#f472b6',
  gray: '#9ca3af',
} as const;

// --- The dashboard charts ---
// One entry per chart: its canvas (`chart-<key>`), its toggle-button label, its
// grid cell, and how to turn a period's rows into datasets. The card markup,
// the toggles and the rendering all walk this list, so a chart can't end up
// drawn but untoggleable, or toggleable with no card to hide (both were
// possible while the cards lived in index.html). Each can be toggled off, which
// removes its whole grid column so the rest reflow to fill the row; the choice
// persists in localStorage.
interface ChartSpec extends ChartSpecBase {
  /** Also the stat-card prefix this chart's unit comes from. */
  key: string;
  label: string;
  /** One entry per plotted series: which measure it reads, and how it looks.
      `col`/`height` come from ChartSpecBase: only the two charts that break the
      grid's default cell size give their own. */
  series: { label: string; field: Measure; color: string; extra?: any }[];
}

const CHART_META: ChartSpec[] = [
  {
    key: 'temp', label: 'Temperature', col: 'col-12 col-xl-8', height: 110,
    series: [
      { label: 'High', field: 'temp_high', color: HUE.red },
      { label: 'Avg',  field: 'temp_avg',  color: HUE.amber },
      { label: 'Low',  field: 'temp_low',  color: HUE.blue },
      { label: 'Dew',  field: 'dew_avg',   color: HUE.green, extra: { borderDash: [4, 3] } },
    ],
  },
  {
    key: 'precip', label: 'Precipitation', type: 'bar', col: 'col-12 col-xl-4', height: 110,
    series: [{ label: 'Precip', field: 'precip', color: HUE.blue }],
  },
  {
    key: 'hum', label: 'Humidity',
    series: [
      { label: 'High', field: 'hum_high', color: HUE.red, extra: { fill: true } },
      { label: 'Avg',  field: 'hum_avg',  color: HUE.amber },
      { label: 'Low',  field: 'hum_low',  color: HUE.blue, extra: { fill: true } },
    ],
    // Humidity is a percentage, so pin the axis rather than letting it autoscale.
    opts: { scales: { y: { min: 0, max: 100 } } },
  },
  {
    key: 'pres', label: 'Pressure',
    series: [
      { label: 'High', field: 'pres_high', color: HUE.violet },
      { label: 'Low',  field: 'pres_low',  color: HUE.indigo, extra: { fill: true } },
    ],
  },
  {
    key: 'wind', label: 'Wind',
    series: [
      { label: 'High', field: 'wind_high', color: HUE.orange, extra: { fill: true } },
      { label: 'Avg',  field: 'wind_avg',  color: HUE.peach },
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

const chartVisibility: Record<string, boolean> = loadChartVisibility();

/**
 * A dashboard chart's canvas id. Only YOY_METRICS names its canvases outright —
 * its series are derived measures with no stored field to name them after.
 */
const chartId = (key: string) => `chart-${key}`;

/** The dashboard: the only view whose chart cards can be toggled off. */
const DASHBOARD_VIEW = view<ChartSpec>('dashboard', {
  specs: CHART_META,
  id: c => chartId(c.key),
  title: c => withUnit(c.label, c.key),
  col: 'col-12 col-md-6 col-xl-4',
  height: 120,
  tableHover: true,
  toggleKey: c => c.key,
});

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
  return rows.map(r => mdOf(r.date));
}

function renderCharts(rows: WeatherRow[]): void {
  drawCharts(DASHBOARD_VIEW, labels(rows), (c, type) =>
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

/**
 * A humidity reading as this table prints it — the one measure here that carries
 * its unit, the rest being bare numbers under a labelled column. The unit comes
 * from the stat card that already names it (see `unitOf`), rather than being
 * written out again per column: '%' was the last unit left as a literal outside
 * STAT_CARDS, in the three cells below.
 */
const humCell = (v: number) => `${v}${unitOf('hum')}`;

const TABLE_COLUMNS: TableColumn[] = [
  { label: 'Date',      cell: r => r.date },
  { label: 'T High',    cell: r => r.temp_high, cls: 'text-danger' },
  { label: 'T Avg',     cell: r => r.temp_avg },
  { label: 'T Low',     cell: r => r.temp_low,  cls: 'text-info' },
  { label: 'Hum High',  cell: r => humCell(r.hum_high), cls: 'text-danger' },
  { label: 'Hum Avg',   cell: r => humCell(r.hum_avg) },
  { label: 'Hum Low',   cell: r => humCell(r.hum_low),  cls: 'text-info' },
  { label: 'Wind High', cell: r => r.wind_high, cls: 'text-warning' },
  { label: 'Wind Avg',  cell: r => r.wind_avg },
  { label: 'Pres High', cell: r => r.pres_high },
  { label: 'Pres Low',  cell: r => r.pres_low },
  { label: 'Precip',    cell: r => r.precip, cls: r => (r.precip > 0 ? 'text-primary' : '') },
];

function renderTable(rows: WeatherRow[]): void {
  fillTable(DASHBOARD_VIEW.table, TABLE_COLUMNS.map(c => c.label), rows, r =>
    tr(TABLE_COLUMNS.map(c => td(c.cell(r), typeof c.cls === 'function' ? c.cls(r) : c.cls))),
  );
}

// --- Missing-day indicator ---
// How completely the period is recorded, beside the chart toggles. The server
// clips the period to the span the station has records for, so only a real gap
// counts: days before the first recording, or not yet imported, don't.
interface Coverage { expected: number; recorded: number; missing: string[] }

/**
 * Consecutive dates folded into runs: "2026-08-03 → 2026-08-06, 2026-09-01".
 * The open run's own last day is what the next date has to follow, so asking
 * that directly replaces a pair of intermediate bindings whose `&&` chains were
 * there only to keep the day arithmetic off an empty run.
 */
function dateRuns(dates: string[]): string {
  const runs: string[][] = [];
  for (const d of dates) {
    const run = last(runs);
    if (run && nextDay(last(run)!) === d) run.push(d);
    else runs.push([d]);
  }
  return runs.map(r => (r.length > 1 ? `${r[0]} → ${last(r)}` : r[0])).join(', ');
}

function renderCoverage(c: Coverage | null): void {
  const badge = el('coverage');
  const missing = c?.missing ?? [];
  const n = missing.length;
  badge.className = `small ms-auto ${n ? 'text-warning' : 'text-muted'}`;
  badge.title = n ? `Missing: ${dateRuns(missing)}` : '';
  badge.textContent = !c
    ? 'No data for this period'
    : !c.expected
      ? 'Outside the recorded span'
      : n
        ? `Missing ${plural(n, 'day')} · ${c.recorded} of ${c.expected} recorded`
        : `All ${plural(c.expected, 'day')} recorded`;
}

// --- Calendar heatmap ---
// One row per month, one cell per day of the month, coloured by the chosen
// measure. Shown only when the period spans two months or more (the Year
// period, a long Range): for a day, a week or one month the charts above
// already say it better. Clicking a day opens it in the Day period.
interface CalMetric {
  field: Measure;
  label: string;
  /** Diverging around the period's mean (temperatures), or sequential from zero. */
  scale: 'diverging' | 'sequential';
}

const CAL_METRICS: CalMetric[] = [
  { field: 'temp_avg',  label: 'Temp avg',  scale: 'diverging' },
  { field: 'temp_high', label: 'Temp high', scale: 'diverging' },
  { field: 'temp_low',  label: 'Temp low',  scale: 'diverging' },
  { field: 'precip',    label: 'Precip',    scale: 'sequential' },
];

/** The heatmap ramps, for a dark surface. Sequential runs dark → light (more
    reads brighter); diverging is blue ↔ red through a neutral gray, and a dry
    day sits at a neutral step of its own so "none" never reads as "a little".
    Both are stop lists for `ramp` below: the diverging one named its three
    stops separately and was blended by hand, which is the same walk along a
    ramp that the sequential one already asks for by name. */
const CAL_COLORS = {
  seq: ['#184f95', '#3987e5', '#86b6ef', '#cde2fb'],
  div: ['#3987e5', '#383835', '#e0524f'],
  none: '#2b2b33',
};

let calMetric: Measure = readStore<Measure>('calMetric', 'temp_avg');
/** What the heatmap last drew, so switching the measure can redraw it. */
let calRows: WeatherRow[] = [];
let calMissing: string[] = [];

/** Blend two `#rrggbb` colours; t = 0 gives `a`, t = 1 gives `b`. */
function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2]
    .map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0'))
    .join('');
}

/** A position along a multi-stop ramp, t in [0, 1]. */
function ramp(stops: string[], t: number): string {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  return mix(stops[i], stops[i + 1], x - i);
}

/**
 * The colour scale for one measure over the shown values, plus the legend that
 * explains it. Temperatures diverge around the period's mean — "colder or
 * warmer than usual for this window" — since a fixed 0 °C pivot would paint a
 * whole summer one colour. Precipitation is sequential on a square-root scale:
 * a few storms would otherwise wash every ordinary wet day out to the floor.
 *
 * It reports the `unit` its legend is labelled in, because the grid it colours
 * puts the same unit on every day cell's hover text and was deriving it from the
 * metric a second time.
 */
function calScale(m: CalMetric, values: number[]) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const unit = unitOf(prefixOf(m.field));
  const fmt = (v: number) => `${round1(v)} ${unit}`;
  if (m.scale === 'sequential') {
    return {
      unit,
      color: (v: number) => (v > 0 && hi > 0 ? ramp(CAL_COLORS.seq, Math.sqrt(v / hi)) : CAL_COLORS.none),
      gradient: `${CAL_COLORS.none} 0 8%, ${CAL_COLORS.seq.join(', ')}`,
      ticks: ['dry', fmt(hi)],
    };
  }
  const mid = mean(values);
  const span = Math.max(hi - mid, mid - lo) || 1;
  // Distance from the mean, in spans, as a position along the cold→mid→warm
  // ramp: -1 lands on the first stop, 0 on the middle one, +1 on the last.
  // Written as a sign test picking which pair of stops to blend, it asked
  // `ramp`'s own question a second time — and left `mid` reachable only by
  // naming the middle stop, which is why the legend bar below could not read
  // its own centre off the scale the way it reads its two ends.
  const color = (v: number) => ramp(CAL_COLORS.div, ((v - mid) / span + 1) / 2);
  return {
    unit,
    color,
    gradient: `${color(lo)}, ${color(mid)}, ${color(hi)}`,
    ticks: [fmt(lo), `mean ${fmt(mid)}`, fmt(hi)],
  };
}

/**
 * `missing` is the period's coverage gaps: those days are dashed. A day with no
 * row that isn't in it lies outside the recorded span (before the station
 * started, or not yet imported) and is left blank, so it doesn't read as a gap.
 */
function renderCalendar(rows: WeatherRow[], missing: string[]): void {
  calRows = rows;
  calMissing = missing;
  const gaps = new Set(missing);
  const months = [...new Set(rows.map(r => monthOf(r.date)))];
  if (months.length < 2) {
    setHtml('calendar', '');
    return;
  }

  const m = CAL_METRICS.find(x => x.field === calMetric) ?? CAL_METRICS[0];
  const byDate = new Map(rows.map(r => [r.date, r]));
  const scale = calScale(m, rows.map(r => r[m.field]));

  // A cell with nothing in it: the corner above the month labels, a day past
  // the end of a short month, and a day outside the recorded span (which is NOT
  // a gap — see above) are all the same empty grid slot, spelled out three ways.
  const blank = '<div></div>';
  const head = `${blank}${MONTH_DAYS.map(d => `<div class="cal-head">${d}</div>`).join('')}`;
  const body = months.map(ym => {
    const [y, mo] = ym.split('-').map(Number);
    // A calendar row's slots: every stored day of the month it is (see `datesIn`).
    const dates = datesIn(ym);
    const cells = MONTH_DAYS.map(d => {
      // A day past the end of a short month has no date to ask about.
      const date = dates[d - 1];
      if (!date) return blank;
      const r = byDate.get(date);
      if (!r) {
        return gaps.has(date)
          ? `<div class="cal-day cal-missing" title="${date} · missing"></div>`
          : blank;
      }
      const v = r[m.field];
      return `<div class="cal-day" data-date="${date}" style="background:${scale.color(v)}"
        title="${date} · ${v} ${scale.unit}"></div>`;
    });
    return `<div class="cal-month">${monthName(mo)} ${String(y).slice(2)}</div>${cells.join('')}`;
  }).join('');

  setHtml('calendar', cardWell({
    cls: 'mb-3',
    body: `<div class="d-flex align-items-center gap-3 mb-2 flex-wrap">
        <h6 class="card-title text-muted mb-0">Calendar</h6>
        <span id="cal-picker"></span>
        <div class="cal-legend ms-auto small text-muted">
          <div class="cal-legend-bar" style="background:linear-gradient(to right, ${scale.gradient})"></div>
          <div class="d-flex justify-content-between">${scale.ticks.map(t => `<span>${t}</span>`).join('')}</div>
        </div>
      </div>
      <div class="cal-grid">${head}${body}</div>`,
  }));

  el('cal-picker').append(mkSelect(
    CAL_METRICS.map(x => ({ value: x.field, label: x.label })),
    m.field,
    function (this: HTMLSelectElement) {
      calMetric = this.value as Measure;
      writeStore('calMetric', calMetric);
      renderCalendar(calRows, calMissing);
    },
  ));
}

// A day cell opens that date in the Day period. Delegated, so the listener
// survives every redraw of the grid.
el('calendar').addEventListener('click', e => {
  const date = (e.target as HTMLElement).dataset?.date;
  if (!date) return;
  period = 'day';
  renderPeriodTabs();
  renderControls();
  const [picker] = selectsIn(el('controls'));
  picker.value = date;
  load();
  window.scrollTo({ top: 0 });
});

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
  /** Also names the stat card this measure's unit comes from (`prefixOf`). */
  key: SharedKey;
  /** Suffix on the chart's series names ("Me · High"); bar charts use none. */
  series?: string;
  /** Heading on the chart card; the unit is appended. */
  title: string;
  /** Label on the summary row; the unit is appended. */
  row: string;
}

/** A Compare chart's canvas id, named after the measure it plots — the four
    entries below each restated theirs as a literal alongside that measure. */
const cmpId = (key: SharedKey) => `cmp-${key.replace(/_/g, '-')}`;

const COMPARE_META: CompareSpec[] = [
  { key: 'temp_high', series: 'High', title: 'Temperature High', row: 'Temp High' },
  { key: 'temp_low',  series: 'Low',  title: 'Temperature Low',  row: 'Temp Low' },
  { key: 'precip',    type: 'bar',    title: 'Precipitation',    row: 'Precip' },
  { key: 'wind_high', series: 'Wind', title: 'Wind Max',         row: 'Wind Max' },
];

/** A Compare heading, whose measure names its stat card by field rather than
    by prefix — its charts and its summary rows both read one. */
const cmpHeading = (text: string, key: SharedKey) => withUnit(text, prefixOf(key));

const COMPARE_VIEW = view<CompareSpec>('cmp', {
  specs: COMPARE_META,
  id: m => cmpId(m.key),
  title: m => cmpHeading(m.title, m.key),
  col: 'col-12 col-xl-6',
  height: 110,
});

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
 * compared, and trailing signed differences between pairs of those columns. Both comparison views are exactly this — mine-vs-Baar over two columns,
 * year-over-year over one per year — and each spelled out the same header
 * assembly, the same row assembly, the same em dash for a missing figure and the
 * same "only when both ends are there" guard around its difference.
 *
 * Each delta names the two columns it compares by index (-1 for the last) and
 * takes the difference itself, because the views take it in opposite
 * directions (mine − theirs; latest − earliest) and only one of them rounds;
 * `of` is handed both ends already known to be present.
 */
/** A difference column: columns `pair[0]` and `pair[1]` (-1 = last), combined by `of`. */
interface Delta { head: string; pair: [number, number]; of: (a: number, b: number) => number }

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
    /** The difference columns; empty when there is nothing to compare against. */
    deltas: Delta[];
  },
): void {
  fillTable(
    id,
    ['Metric', ...o.columns, ...o.deltas.map(d => d.head)],
    o.metrics,
    m => {
      const values = o.values(m);
      const fmt = o.format(m);
      const at = (i: number) => values[i < 0 ? values.length + i : i] ?? null;
      return tr([
        td(o.label(m)),
        ...values.map(v => numCell(v, fmt)),
        ...o.deltas.map(d => {
          const [a, b] = [at(d.pair[0]), at(d.pair[1])];
          return deltaCell(a != null && b != null ? d.of(a, b) : null, fmt);
        }),
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
  { name: 'compare', show: () => loadCompare() },
  { name: 'yoy', show: () => { renderYoyControls(); loadYoy(); loadYtd(); } },
] as const;

/** An overlay's navbar button — named after the overlay, as its view already is. */
const overlayBtn = (name: string) => el(`btn-${name}`);

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
    overlayBtn(o.name).classList.toggle('active', on);
    if (on) o.show();
  }
}

// Each overlay button toggles its own view, falling back to the dashboard.
for (const o of OVERLAYS) {
  overlayBtn(o.name).addEventListener('click', () =>
    showView(currentView === o.name ? 'dashboard' : o.name));
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
  // Named once: the label is written before the fetch, so a failure still says
  // which window was being compared, and again after it with what the reply
  // could supply appended.
  const range = `${from} → ${to}`;
  el('cmp-range').textContent = range;

  const data = await loadInto<{
    mine: WeatherRow[]; public: PublicRow[]; normals: PublicRow[]; normals_label: string;
  }>(
    status, api('compare', { from, to }),
    'Loading public data…', 'Could not fetch public data',
  );
  if (!data) return;

  // Both public series are read off MY dates, so every side shares one x-axis
  // and a date the service has no row for contributes a gap. Each of them
  // spelled that lookup out itself.
  const alignedTo = (by: Map<string, PublicRow>) => (key: SharedKey) =>
    lastRows.map(r => by.get(r.date)?.[key] ?? null);
  const normals = new Map<string, PublicRow>(data.normals.map(n => [n.date, n]));

  // The long-term normal is a third side when the server could supply it — it
  // can't on a first use while offline, and the comparison stands without. It is
  // spread into the list rather than pushed onto it afterwards, so the sides,
  // their order and the condition for the third all read in one place.
  const sides: CompareSide[] = [
    { name: 'Me', head: 'My avg', color: HUE.sky, values: key => lastRows.map(r => r[key]) },
    {
      name: 'Baar', head: 'Baar avg', color: HUE.orange, extra: { borderDash: [5, 3] },
      values: alignedTo(new Map<string, PublicRow>(data.public.map(p => [p.date, p]))),
    },
    ...(normals.size
      ? [{
          name: 'Normal', head: 'Normal', color: HUE.gray,
          extra: { borderDash: [2, 3], pointRadius: 0 },
          values: alignedTo(normals),
        }]
      : []),
  ];

  el('cmp-range').textContent =
    range +
    (normals.size ? ` · Normal: Baar ${data.normals_label}` : ' · Long-term normal unavailable');

  // Lines name their measure ("Me · High"); the bar chart has only one.
  drawCharts(COMPARE_VIEW, labels(lastRows), (m, type) =>
    sides.map(s =>
      series(type, `${s.name}${m.series ? ` · ${m.series}` : ''}`, s.values(m.key), s.color, s.extra),
    ));

  renderCompareSummary(sides);
}

function renderCompareSummary(sides: CompareSide[]): void {
  const avg = (vals: (number | null)[]): number | null => {
    const v = vals.filter((x): x is number => x != null && !Number.isNaN(x));
    return v.length ? mean(v) : null;
  };
  // One decimal throughout — every measure compared here is a plain reading.
  const one = (n: number) => n.toFixed(1);
  // Every difference on this table is a plain subtraction between two of its
  // columns; only which two differ, which is what the three entries below say.
  const diff = (head: string, a: number, b: number): Delta =>
    ({ head, pair: [a, b], of: (x, y) => x - y });

  renderDeltaTable(COMPARE_VIEW.table, {
    columns: sides.map(s => s.head),
    metrics: COMPARE_META,
    label: m => cmpHeading(m.row, m.key),
    values: m => sides.map(s => avg(s.values(m.key))),
    format: () => one,
    // Mine against Baar, then — when the normals loaded — each against the
    // long-term normal: the "warmer / wetter than usual" reading.
    deltas: [
      diff('Me − Baar', 0, 1),
      ...(sides.length > 2 ? [diff('Me vs normal', 0, 2), diff('Baar vs normal', 1, 2)] : []),
    ],
  });
}

// --- Across years (year-over-year) ---
// Compare the SAME day, week or month across every year in the data. The server
// gathers each year's rows for the chosen period; here each year becomes one
// overlaid series (aligned on a shared within-period axis) plus one column in
// the averages table.
interface YearBlock {
  year: number;
  rows: WeatherRow[];
  stats: Stats;
  /** Days behind this year's figures, against the period's calendar length. */
  days: { recorded: number; total: number };
}
interface YoyResponse { unit: YoyUnit; label: string; years: YearBlock[]; }

/**
 * A year that recorded only part of the period — started mid-month, still
 * under way, or with gaps. Its averages and totals cover fewer days than a
 * complete year's, so setting the two side by side needs saying so: a March
 * five days old next to a whole March otherwise reads as a like-for-like pair.
 */
const isPartial = (y: YearBlock): boolean => y.days.recorded < y.days.total;

/** A year's column head: the year, and how many of the period's days it holds. */
const yearHead = (y: YearBlock): string =>
  `${y.year}<div class="small fw-normal ${isPartial(y) ? 'text-warning' : 'text-muted'}">` +
  `${y.days.recorded}/${plural(y.days.total, 'day')}</div>`;

/**
 * One entry per comparison unit — its `ControlStrip` (label, value pickers and
 * the /api/across-years params they imply, with the `unit` param itself coming
 * from the entry's own key), plus where a row sits inside the period and the
 * shared x-axis. Like PERIODS above, the unit is dispatched once here rather
 * than in four if/else chains (controls, url, position, axis) that had to stay
 * in step.
 */
interface YoyUnitSpec extends ControlStrip {
  /** The row's slot inside its period, so the same slot lines up across years. */
  pos: (r: WeatherRow) => number;
  /** The shared x-axis for this unit: slot positions and their labels. */
  axis: (label: string) => { positions: number[]; labels: string[] };
}

const YOY_UNITS = {
  day: {
    label: 'Day',
    ...paramPickers(loadYoy, [
      ['month', monthSelect],
      ['day', daySelect],
    ]),
    pos: () => 1,                                        // a single slot
    axis: label => ({ positions: [1], labels: [label] }),
  },

  week: {
    label: 'Week',
    ...paramPickers(loadYoy, [['week', weekSelect]]),
    pos: r => localDate(r.date).getDay() || 7,           // Mon=1..Sun=7
    axis: () => ({ positions: oneTo(WEEKDAYS.length), labels: WEEKDAYS }),
  },

  month: {
    label: 'Month',
    ...paramPickers(loadYoy, [['month', monthSelect]]),
    pos: r => dayOf(r.date),                             // day of month, 1..31
    axis: () => ({ positions: MONTH_DAYS, labels: MONTH_DAYS.map(String) }),
  },
} satisfies Record<string, YoyUnitSpec>;

type YoyUnit = keyof typeof YOY_UNITS;

/** The Across-Years view's value pickers — the unit selector sits beside them. */
const YOY_STRIP = stripsIn('yoy-controls', YOY_UNITS);

// A distinct colour per year across all the charts. Keyed by the year itself,
// not its position in a reply: the unit charts omit a year with no data for the
// period, and indexing by position then repainted every later year.
const YEAR_COLORS = [HUE.sky, HUE.orange, HUE.green, HUE.pink, HUE.amber, HUE.violet];
const yearColor = (year: number) => YEAR_COLORS[year % YEAR_COLORS.length];

// One chart per metric; each draws one line (or bar) per year. `get` reads the
// plotted value from a row — a function, not a key, so derived measures like
// mid-pressure fit the same list.
interface YoyMetric extends ChartSpecBase {
  id: string;
  /** The stat card this metric's unit comes from. */
  prefix: string;
  /** Heading on the chart card; the unit is appended. */
  label: string;
  get: (r: WeatherRow) => number;
}
const YOY_METRICS: YoyMetric[] = [
  { id: 'yoy-temp-avg',  prefix: 'temp',   label: 'Temp Avg',      get: r => r.temp_avg },
  { id: 'yoy-temp-high', prefix: 'temp',   label: 'Temp High',     get: r => r.temp_high },
  { id: 'yoy-temp-low',  prefix: 'temp',   label: 'Temp Low',      get: r => r.temp_low },
  { id: 'yoy-hum-avg',   prefix: 'hum',    label: 'Humidity Avg',  get: r => r.hum_avg },
  { id: 'yoy-wind-high', prefix: 'wind',   label: 'Wind Max',      get: r => r.wind_high },
  { id: 'yoy-pres-avg',  prefix: 'pres',   label: 'Pressure Avg',
    get: r => (r.pres_high + r.pres_low) / 2 },
  { id: 'yoy-precip',    prefix: 'precip', label: 'Precipitation', type: 'bar',
    get: r => r.precip },
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
  { label: 'Rain days',    prefix: 'rain',   key: 'days' },
  { label: 'Rain days %',  prefix: 'rain',   key: 'pct' },
  { label: 'Longest wet spell', prefix: 'spell', key: 'wet' },
  { label: 'Longest dry spell', prefix: 'spell', key: 'dry' },
  { label: 'Frost days',   prefix: 'frost',  key: 'frost' },
  { label: 'Summer days',  prefix: 'summer', key: 'summer' },
];

// The current comparison unit; its value pickers are rebuilt when it changes.
let yoyUnit: YoyUnit = 'month';

const YOY_VIEW = view<YoyMetric>('yoy', {
  specs: YOY_METRICS,
  id: m => m.id,
  title: m => withUnit(m.label, m.prefix),
  col: 'col-12 col-md-6 col-xl-4',
  height: 120,
});

/** Rebuild the unit selector and the value pickers it implies. */
function renderYoyControls(): void {
  const unitSel = mkSelect(YOY_STRIP.options, yoyUnit, () => {
    yoyUnit = unitSel.value as YoyUnit;
    renderYoyControls();
    loadYoy();
  });
  // The unit selector picks WHICH strip to show, so it sits in its own box
  // beside the strip rather than at the head of it — leaving `yoy-controls`
  // holding exactly the unit's own value pickers, in the order it named them.
  emptyEl('yoy-unit').append(mutedLabel('Compare'), unitSel);
  YOY_STRIP.render(yoyUnit);
}

/** Turn the current value pickers into the /api/across-years call. */
function yoyUrl(): string {
  return api('across-years', { unit: yoyUnit, ...YOY_STRIP.params(yoyUnit) });
}

async function loadYoy(): Promise<void> {
  const status = el('yoy-status');
  const data = await loadInto<YoyResponse>(status, yoyUrl(), 'Loading…', 'Could not load');
  if (!data) return;

  el('yoy-heading').textContent = `${data.label} across years`;
  if (!data.years.length) {
    status.textContent = 'No data for this period.';
    clearView(YOY_VIEW);
    return;
  }
  const partial = data.years.filter(isPartial);
  status.textContent = [
    data.years.length < 2
      ? `Only ${data.years[0].year} has data for this period — add another year to compare.`
      : '',
    partial.length
      ? `Partial: ${partial.map(y => `${y.year} has ${y.days.recorded} of ${plural(y.days.total, 'day')}`)
          .join(', ')} — not directly comparable with a complete period.`
      : '',
  ].filter(Boolean).join(' ');

  const spec = YOY_UNITS[data.unit];
  const { positions, labels: xlabels } = spec.axis(data.label);
  // Per year: within-period slot → that day's row, so each x-slot can pull each
  // year's value (or null where a year is missing that day).
  const byPos = data.years.map(yb => new Map(yb.rows.map(row => [spec.pos(row), row])));

  drawCharts(YOY_VIEW, xlabels, (metric, type) => {
    const perYear = data.years.map((yb, i) =>
      series(
        type,
        String(yb.year),
        positions.map(p => { const row = byPos[i].get(p); return row ? metric.get(row) : null; }),
        yearColor(yb.year),
      ));
    if (data.years.length < 2) return perYear;
    // The mean of every year that recorded the slot — the baseline a single
    // year reads as warm, wet or windy against. Per slot, so a partial year
    // weighs in only on the days it has; and only where at least two years
    // did, since the "mean" of one year is just that year's line again. Always
    // a dashed line, even over the precipitation bars, so it reads as a
    // reference rather than another year.
    const meanLine = positions.map(p => {
      const vals = byPos.flatMap(m => { const row = m.get(p); return row ? [metric.get(row)] : []; });
      return vals.length >= 2 ? round1(mean(vals)) : null;
    });
    return [
      ...perYear,
      series('line', `Mean of ${data.years.length} years`, meanLine, HUE.gray, {
        type: 'line', borderDash: [5, 3], order: -1,
      }),
    ];
  });

  renderYoySummary(data);
}

function renderYoySummary(data: YoyResponse): void {
  renderDeltaTable(YOY_VIEW.table, {
    // Each year's head says how many of the period's days its figures cover.
    columns: data.years.map(yearHead),
    metrics: YOY_SUMMARY,
    label: m => m.label,
    // A row names the stat card it reads, so both the accessor and the unit come
    // from STAT_CARDS rather than being restated here.
    values: m => data.years.map(y => CARD_BY_PREFIX[m.prefix].pick(y.stats)[m.key]),
    format: m => v => statText(m.prefix, m.key, v),
    // With ≥2 years, a trailing column shows the change from the earliest to the
    // latest year — the headline "how did this period differ" number.
    deltas:
      data.years.length >= 2
        ? [{
            head: 'Δ latest−earliest',
            pair: [0, -1],
            of: (earliest, latest) => round1(latest - earliest),
          }]
        : [],
  });
}

// --- Year-to-date precipitation ---
// Each year's running rain total on one Jan–Dec axis, so "is this a wet year?"
// reads at a glance. Independent of the unit pickers above it: it always spans
// whole years. A year whose record starts mid-year accumulates from its first
// recorded day, and the note under the heading says so.
interface YtdYear { year: number; days: { md: string; total: number }[] }

const YTD_CHART = 'ytd-chart';
/**
 * The line under the heading, which doubles as this chart's status line. Named
 * beside the canvas it sits over, rather than spelled out as a literal at the
 * four points that touch it — once in the shell that creates it and three times
 * in the loader that writes to it, which also looked it up three times over.
 */
const YTD_NOTE = 'ytd-note';

/** Every MM-DD of a leap year — the shared x-axis, so 29 Feb has a slot. */
const YTD_AXIS: string[] = datesIn('2024').map(mdOf);

/** "Sep 27" for "09-27". */
const mdLabel = (md: string) => `${mdMonth(md)} ${mdDayNo(md)}`;

function renderYtdShell(): void {
  setHtml('yoy-ytd', cardWell({
    cls: 'mb-3',
    body: `<h6 class="card-title text-muted mb-1">${withUnit('Year-to-date precipitation', 'precip')}</h6>
      <div id="${YTD_NOTE}" class="small text-muted mb-2"></div>
      <canvas id="${YTD_CHART}" height="60"></canvas>`,
  }));
}

async function loadYtd(): Promise<void> {
  // The note under the heading doubles as this chart's status line, the way
  // both overlays already report through one of their own.
  const note = el(YTD_NOTE);
  const data = await loadInto<{ years: YtdYear[] }>(
    note, '/api/precip-ytd', 'Loading…', 'Could not load',
  );
  if (!data) return;
  const { years } = data;
  if (!years.length) {
    note.textContent = 'No data yet.';
    destroyChart(YTD_CHART);
    return;
  }

  // The headline comparison: every year's total as of the newest recorded
  // day-of-year, e.g. "As of Sep 27: 2026 612 mm · 2025 98 mm (from Sep 1)".
  const asOf = last(last(years)!.days)!.md;
  const unit = unitOf('precip');
  note.textContent = `As of ${mdLabel(asOf)}: ` + [...years].reverse().map(y => {
    const upTo = y.days.filter(d => d.md <= asOf);
    const total = last(upTo)?.total;
    const partial = y.days[0].md !== '01-01' ? ` (from ${mdLabel(y.days[0].md)})` : '';
    return total === undefined ? `${y.year} —` : `${y.year} ${total} ${unit}${partial}`;
  }).join(' · ');

  mkChart(YTD_CHART, 'line', {
    labels: YTD_AXIS.map(mdLabel),
    datasets: years.map(y => {
      const at = new Map(y.days.map(d => [d.md, d.total]));
      return series('line', String(y.year), YTD_AXIS.map(md => at.get(md) ?? null), yearColor(y.year),
        { pointRadius: 0, tension: 0, spanGaps: true, borderWidth: 2 });
    }),
  }, {
    interaction: { mode: 'index', intersect: false },
    scales: {
      // One tick per month, on its first day.
      x: { ticks: { autoSkip: false, maxRotation: 0,
        callback: (_v: unknown, i: number) => (isMonthStart(YTD_AXIS[i]) ? mdMonth(YTD_AXIS[i]) : '') },
        // …and a grid line only there, rather than one per day.
        grid: {
          color: (c: { index: number }) =>
            isMonthStart(YTD_AXIS[c.index]) ? CHROME.grid : 'transparent',
        } },
      y: { min: 0 },
    },
  });
}

// --- Init ---
(async () => {
  renderPeriodTabs();
  renderStatCards();
  // Each view builds its own shell: chart cards, then its table card. Each
  // table's header is filled alongside its rows, by whatever renders them.
  renderView(DASHBOARD_VIEW);
  renderView(COMPARE_VIEW);
  renderView(YOY_VIEW);
  renderYtdShell();
  renderChartToggles();
  applyChartVisibility();   // apply persisted hidden state immediately, even before charts render
  await reloadDates();
})();
