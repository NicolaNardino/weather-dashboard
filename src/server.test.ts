import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { insertRows, row } from './test/helpers';
import { app } from './server';
import { PUBLIC_FIELDS, upsertNormals, upsertPublic } from './db';
import { MD_AXIS } from './normals';

let server: Server;
let base = '';

const get = async (path: string) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: await r.json() as any };
};

before(async () => {
  // March 2020, with the 3rd missing and rain on the 4th and 5th.
  insertRows([
    row('2020-03-01'), row('2020-03-02', { temp_low: -2 }),
    row('2020-03-04', { precip: 3 }), row('2020-03-05', { precip: 1 }),
    row('2021-03-01', { precip: 2 }),
  ]);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test('a period returns rows, stats and coverage clipped to the recorded span', async () => {
  const { status, body } = await get('/api/month?year=2020&month=3');
  assert.equal(status, 200);
  assert.equal(body.rows.length, 4);
  assert.equal(body.stats.rain.days, 2);
  assert.deepEqual(body.stats.spells.wet, { days: 2, from: '2020-03-04', to: '2020-03-05' });
  assert.equal(body.stats.climate.frost, 1);
  // Records start on 1 March 2020, so the month counts from there to its end.
  assert.deepEqual(body.coverage, { expected: 31, recorded: 4, missing: [
    '2020-03-03', ...Array.from({ length: 26 }, (_, i) => `2020-03-${String(i + 6).padStart(2, '0')}`),
  ] });
});

test('a window entirely outside the record expects no days', async () => {
  const { body } = await get('/api/range?from=2019-01-01&to=2019-01-31');
  assert.deepEqual(body.coverage, { expected: 0, recorded: 0, missing: [] });
});

test('the day route 404s on a missing day; bad params are 400s', async () => {
  assert.equal((await get('/api/day?date=2020-03-03')).status, 404);
  assert.equal((await get('/api/week?year=abc&week=1')).status, 400);
  assert.equal((await get('/api/across-years?unit=decade')).status, 400);
});

test('across-years says how many of the period\'s days each year covers', async () => {
  // March 2020 holds 4 days, March 2021 just one — both partial months. Neither
  // is clipped to the recorded span: the comparison is against a whole March.
  const month = await get('/api/across-years?unit=month&month=3');
  assert.equal(month.status, 200);
  assert.deepEqual(
    month.body.years.map((y: any) => [y.year, y.days]),
    [[2020, { recorded: 4, total: 31 }], [2021, { recorded: 1, total: 31 }]],
  );

  // A single day is complete wherever it is recorded, and a year without it is
  // left out rather than reported as 0 of 1.
  const day = await get('/api/across-years?unit=day&month=3&day=1');
  assert.deepEqual(
    day.body.years.map((y: any) => [y.year, y.days]),
    [[2020, { recorded: 1, total: 1 }], [2021, { recorded: 1, total: 1 }]],
  );
  const onlyOne = await get('/api/across-years?unit=day&month=3&day=4');
  assert.deepEqual(onlyOne.body.years.map((y: any) => y.year), [2020]);

  // ISO week 10 is 2–8 March 2020 (three of its days recorded) but 8–14 March
  // 2021, which holds none — so only 2020 is compared, out of seven days.
  const week = await get('/api/across-years?unit=week&week=10');
  assert.deepEqual(
    week.body.years.map((y: any) => [y.year, y.days]),
    [[2020, { recorded: 3, total: 7 }]],
  );
});

test('precip-ytd accumulates within each year', async () => {
  const { body } = await get('/api/precip-ytd');
  assert.deepEqual(body.years.map((y: any) => [y.year, y.days.at(-1).total]), [[2020, 4], [2021, 2]]);
  assert.deepEqual(body.years[0].days.map((d: any) => d.total), [0, 0, 3, 4]);
});

test('compare serves cached public data and the long-term normals, offline', async () => {
  // Past days fully cached, and a complete normals table: no network needed.
  upsertPublic('Baar, CH', ['2020-03-01', '2020-03-02'].map(date =>
    ({ date, temp_high: 14, temp_low: 3, wind_high: 20, precip: 0 })));
  upsertNormals('Baar, CH', MD_AXIS.map(md =>
    ({ md, ...Object.fromEntries(PUBLIC_FIELDS.map(f => [f, md === '03-01' ? 7 : 1])) } as any)));

  const { status, body } = await get('/api/compare?from=2020-03-01&to=2020-03-02');
  assert.equal(status, 200);
  assert.equal(body.cached, true);
  assert.equal(body.public.length, 2);
  assert.deepEqual(body.normals.map((n: any) => [n.date, n.temp_high]), [['2020-03-01', 7], ['2020-03-02', 1]]);
  assert.match(body.normals_label, /1991–2020/);
});
