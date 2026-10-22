/**
 * The shapes the API answers with — written once, for both sides of it.
 *
 * The server builds these and the front-end reads them, and until now each
 * said what they are for itself: `db.ts` derived them from its column lists
 * and let `aggregateStats`/`coverage` infer the rest, while `app.ts` opened
 * with forty lines of hand-written interfaces mirroring the same five shapes.
 * Nothing held the two in step — a measure renamed, a stat card dropped or a
 * figure's type changed on the server reached the browser as `undefined` at
 * runtime, with both files type-checking cleanly the whole way.
 *
 * This is a `.d.ts` rather than a module of its own because of how the client
 * is built: `tsconfig.client.json` compiles `src/client/app.ts` to a single
 * `public/app.js` with no bundler and `rootDir` set to `src/client`, so a
 * plain `.ts` outside it is both a rootDir error and a second emitted file.
 * A declaration file is never emitted, and a type-only import of one is
 * elided — the browser bundle is exactly as it was.
 */

/**
 * The measure columns, in the order they appear in `weather_data.txt` after
 * the date. `db.ts` annotates its `FIELDS` array with this tuple, so the list
 * that builds the table and drives the import has to match it exactly —
 * length, order and spelling alike.
 */
export type FieldList = readonly [
  "temp_high",
  "temp_avg",
  "temp_low",
  "dew_high",
  "dew_avg",
  "dew_low",
  "hum_high",
  "hum_avg",
  "hum_low",
  "wind_high",
  "wind_avg",
  "wind_low",
  "pres_high",
  "pres_low",
  "precip",
];

/** One stored measure — every column of a weather row but the date. */
export type Field = FieldList[number];

/** The measures the public weather service supplies — the Compare axis. */
export type PublicFieldList = readonly ["temp_high", "temp_low", "wind_high", "precip"];

export type PublicField = PublicFieldList[number];

/** The column a row of public readings is keyed by — a day, or a calendar day. */
export type FieldKey = "date" | "md";

/**
 * A row of one reading per public field, under the key that identifies it — a
 * `date` for a fetched or cached day, an `md` for a long-term normal.
 */
export type FieldRow<K extends FieldKey> = Record<K, string> &
  Record<PublicField, number | null>;

/** A cached public-service day: the date, and one nullable number per field. */
export type PublicRow = FieldRow<"date">;

/** A row of the `weather` table: the id, the date, and one number per Field. */
export type WeatherRow = { id: number; date: string } & Record<Field, number>;

/** A run of consecutive days; `from`/`to` are null when no day qualified. */
export interface Spell {
  days: number;
  from: string | null;
  to: string | null;
}

/**
 * A `<prefix>_high`/`_low` pair around a mean. A type alias rather than an
 * interface because the stat cards read their group as a
 * `Record<string, number>`, which an interface gets no index signature for.
 */
export type StatTriple = { high: number; avg: number; low: number };

/** The stat-card figures over a set of rows — what `aggregateStats` returns. */
export interface Stats {
  temp: StatTriple;
  dew: StatTriple;
  humidity: StatTriple;
  wind: { high: number; avg: number };
  pressure: StatTriple;
  precip: { total: number; max: number };
  rain: { days: number; dry: number; pct: number };
  climate: { frost: number; ice: number; summer: number; hot: number };
  spells: { wet: Spell; dry: Spell; hot: Spell };
}

/** How completely a window is recorded — what `coverage` returns. */
export interface Coverage {
  expected: number;
  recorded: number;
  missing: string[];
}

/**
 * The reply each route answers with — the other half of saying the API's
 * shapes once.
 *
 * The row and stat shapes above are shared, but the envelopes carrying them
 * were still stated twice over: the server built each as a bare object literal
 * in `res.json(…)`, and `app.ts` declared its own interface to read it back.
 * Nothing held the two together, and they had already drifted — the page
 * believed a period always comes with stats, when a window with no rows
 * carries `stats: null`, and it re-spelled an import's four counters field for
 * field beside `ImportResult`, which `import.ts` already declares.
 *
 * The server now says `satisfies` on each reply, so a field renamed or dropped
 * there is a compile error here rather than an `undefined` in the browser.
 */

/** What every period route answers with; `stats` is null for an empty window. */
export interface PeriodReply {
  rows: WeatherRow[];
  stats: Stats | null;
  coverage: Coverage;
}

/**
 * The three year-over-year comparison units. Both sides keep a table keyed by
 * these — the server's answers the request, the page's holds that unit's
 * pickers and axis — so this pins them the way `FieldList` pins the measures:
 * a fourth unit added to one table and not the other is a compile error.
 */
export type YoyUnitKey = "day" | "week" | "month";

/** One year's block of an across-years reply. */
export interface YearBlock {
  year: number;
  rows: WeatherRow[];
  stats: Stats | null;
  /** Days behind this year's figures, against the period's calendar length. */
  days: { recorded: number; total: number };
}

export interface AcrossYearsReply {
  unit: YoyUnitKey;
  label: string;
  years: YearBlock[];
}

/** One year's running precipitation total, one point per recorded day. */
export interface PrecipYtdYear {
  year: number;
  days: { md: string; total: number }[];
}

export interface PrecipYtdReply {
  years: PrecipYtdYear[];
}

/** Data freshness: when the file was last imported, and how many rows are stored. */
export interface StatusReply {
  last_import: string | null;
  records: number;
}

/** What an import did — the counters `import.ts` reports and the button shows. */
export interface ImportResult {
  /** Valid data rows found in the file. */
  total: number;
  /** Dates not previously in the DB. */
  inserted: number;
  /** Dates that existed but whose values changed. */
  updated: number;
  /** Dates already present with identical values. */
  unchanged: number;
}

export interface ImportReply extends ImportResult {
  ok: true;
}

/**
 * My rows beside the public service's over the same window, plus the long-term
 * normals and where the public side came from (see ORIGIN in server.ts).
 */
export interface CompareReply {
  location: string;
  cached: boolean;
  /** Only set when a failed fetch fell back to the cache. */
  stale?: boolean;
  source: string;
  mine: WeatherRow[];
  public: PublicRow[];
  normals: PublicRow[];
  normals_label: string;
}
