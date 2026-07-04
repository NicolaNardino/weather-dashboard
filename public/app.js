/* global Chart */

const CHART_DEFAULTS = {
  responsive: true,
  animation: false,
  plugins: { legend: { labels: { color: '#aaa', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#888', maxRotation: 45, font: { size: 10 } }, grid: { color: '#333' } },
    y: { ticks: { color: '#888', font: { size: 10 } }, grid: { color: '#333' } },
  },
};

function mergeOpts(extra) {
  return Object.assign({}, CHART_DEFAULTS, extra);
}

const charts = {};

function mkChart(id, type, data, extraOpts = {}) {
  const ctx = document.getElementById(id);
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, { type, data, options: mergeOpts(extraOpts) });
}

// --- State ---
let period = 'week';
let allDates = [];
let lastRows = [];   // rows from the most recent dashboard load (drives Compare range)

// --- Nav tabs ---
document.querySelectorAll('[data-period]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    period = btn.dataset.period;
    renderControls();
    load();
  });
});

// --- Controls ---
function renderControls() {
  const el = document.getElementById('controls');
  el.innerHTML = '';

  if (period === 'day') {
    const dates = allDates.map(d => d.date);
    const sel = document.createElement('select');
    dates.forEach(d => {
      const o = document.createElement('option');
      o.value = d; o.textContent = d;
      sel.appendChild(o);
    });
    if (dates.length) sel.value = dates[dates.length - 1];
    sel.addEventListener('change', load);
    el.appendChild(sel);

  } else if (period === 'week') {
    const yearSel = yearSelect();
    const weekSel = document.createElement('select');
    for (let w = 1; w <= 53; w++) {
      const o = document.createElement('option');
      o.value = w; o.textContent = `Week ${w}`;
      weekSel.appendChild(o);
    }
    weekSel.value = isoWeek(refDate());
    yearSel.addEventListener('change', load);
    weekSel.addEventListener('change', load);
    el.appendChild(yearSel);
    el.appendChild(weekSel);

  } else if (period === 'month') {
    const yearSel = yearSelect();
    const monthSel = document.createElement('select');
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    names.forEach((n, i) => {
      const o = document.createElement('option');
      o.value = i + 1; o.textContent = n;
      monthSel.appendChild(o);
    });
    monthSel.value = refDate().getMonth() + 1;
    yearSel.addEventListener('change', load);
    monthSel.addEventListener('change', load);
    el.appendChild(yearSel);
    el.appendChild(monthSel);

  } else if (period === 'year') {
    el.appendChild(yearSelect());
    el.querySelector('select').addEventListener('change', load);

  } else if (period === 'range') {
    // Two date pickers populated ONLY from dates that exist in the data,
    // so the user can never select a window outside the recorded range.
    const dates = allDates.map(d => d.date);
    const fromSel = document.createElement('select');
    const toSel = document.createElement('select');
    dates.forEach(d => {
      const of = document.createElement('option'); of.value = d; of.textContent = d; fromSel.appendChild(of);
      const ot = document.createElement('option'); ot.value = d; ot.textContent = d; toSel.appendChild(ot);
    });
    if (dates.length) {
      toSel.value = dates[dates.length - 1];
      // Default to the last ~30 available days for a sensible starting window.
      fromSel.value = dates[Math.max(0, dates.length - 30)];
    }
    fromSel.addEventListener('change', load);
    toSel.addEventListener('change', load);
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

function yearSelect() {
  const years = [...new Set(allDates.map(d => d.date.slice(0, 4)))];
  const sel = document.createElement('select');
  (years.length ? years : [String(new Date().getFullYear())]).forEach(y => {
    const o = document.createElement('option');
    o.value = y; o.textContent = y;
    sel.appendChild(o);
  });
  sel.value = years[years.length - 1] || String(new Date().getFullYear());
  return sel;
}

// Reference date = latest date that actually has data (falls back to today
// when no data is loaded). Selectors default to this period so a fresh load
// lands on populated data rather than the empty calendar-current period.
function refDate() {
  if (allDates.length) {
    const [y, m, d] = allDates[allDates.length - 1].date.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

function isoWeek(d) {
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const diff = d - jan4;
  return Math.ceil((diff / 86400000 + (jan4.getDay() || 7)) / 7);
}

// --- Load data ---
async function load() {
  const el = document.getElementById('controls');
  const sels = el.querySelectorAll('select');
  let url;

  if (period === 'day') {
    url = `/api/day?date=${sels[0]?.value ?? ''}`;
  } else if (period === 'week') {
    url = `/api/week?year=${sels[0]?.value}&week=${sels[1]?.value}`;
  } else if (period === 'month') {
    url = `/api/month?year=${sels[0]?.value}&month=${sels[1]?.value}`;
  } else if (period === 'range') {
    let from, to;
    if (document.getElementById('range-all')?.checked && allDates.length) {
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
  const { rows, stats } = await resp.json();

  lastRows = rows;
  renderStats(stats);
  renderCharts(rows);
  renderTable(rows);
}

// --- Data freshness (last import time) ---
async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const { last_import, records } = await r.json();
    const el = document.getElementById('last-import');
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
function renderStats(s) {
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

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// --- Charts ---
function labels(rows) {
  return rows.map(r => r.date.slice(5)); // MM-DD
}

function renderCharts(rows) {
  const lbl = labels(rows);

  mkChart('chart-temp', 'line', {
    labels: lbl,
    datasets: [
      { label: 'High',  data: rows.map(r => r.temp_high), borderColor: '#f87272', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3 },
      { label: 'Avg',   data: rows.map(r => r.temp_avg),  borderColor: '#facc15', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3 },
      { label: 'Low',   data: rows.map(r => r.temp_low),  borderColor: '#60a5fa', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3 },
      { label: 'Dew',   data: rows.map(r => r.dew_avg),   borderColor: '#4ade80', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3, borderDash: [4,3] },
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
      { label: 'High', data: rows.map(r => r.hum_high), borderColor: '#f87272', backgroundColor: '#f8727211', fill: true, pointRadius: 2, tension: 0.3 },
      { label: 'Avg',  data: rows.map(r => r.hum_avg),  borderColor: '#facc15', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3 },
      { label: 'Low',  data: rows.map(r => r.hum_low),  borderColor: '#60a5fa', backgroundColor: '#60a5fa11', fill: true, pointRadius: 2, tension: 0.3 },
    ],
  }, { scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 } } });

  mkChart('chart-pres', 'line', {
    labels: lbl,
    datasets: [
      { label: 'High', data: rows.map(r => r.pres_high), borderColor: '#a78bfa', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3 },
      { label: 'Low',  data: rows.map(r => r.pres_low),  borderColor: '#818cf8', backgroundColor: '#818cf811', fill: true, pointRadius: 2, tension: 0.3 },
    ],
  });

  mkChart('chart-wind', 'line', {
    labels: lbl,
    datasets: [
      { label: 'High', data: rows.map(r => r.wind_high), borderColor: '#fb923c', backgroundColor: '#fb923c11', fill: true, pointRadius: 2, tension: 0.3 },
      { label: 'Avg',  data: rows.map(r => r.wind_avg),  borderColor: '#fdba74', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3 },
    ],
  });
}

// --- Table ---
function renderTable(rows) {
  const tbody = document.getElementById('table-body');
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

function clearAll() {
  ['chart-temp','chart-precip','chart-hum','chart-pres','chart-wind'].forEach(id => {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  });
  document.getElementById('table-body').innerHTML = '';
}

// --- Import button ---
document.getElementById('btn-import').addEventListener('click', async () => {
  const btn = document.getElementById('btn-import');
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/import', { method: 'POST' });
    const j = await r.json();
    // Report what actually changed, not just the row count in the file.
    btn.textContent = `✓ ${j.inserted} new · ${j.updated} upd`;
    btn.title = `${j.total} rows processed — ${j.inserted} new, ${j.updated} updated, ${j.unchanged} unchanged`;
    // refresh dates and reload
    const resp = await fetch('/api/dates');
    allDates = await resp.json();
    renderControls();
    await load();
    await refreshStatus();
  } catch (e) {
    btn.textContent = '✗ Error';
  } finally {
    setTimeout(() => { btn.textContent = '↻ Import'; btn.disabled = false; }, 2000);
  }
});

// --- Compare vs public service (Baar) ---
const cmpCharts = {};
let compareOn = false;

function mkCmpChart(id, type, data, extraOpts = {}) {
  const ctx = document.getElementById(id);
  if (cmpCharts[id]) cmpCharts[id].destroy();
  cmpCharts[id] = new Chart(ctx, { type, data, options: mergeOpts(extraOpts) });
}

document.getElementById('btn-compare').addEventListener('click', () => {
  compareOn = !compareOn;
  const btn = document.getElementById('btn-compare');
  document.getElementById('dashboard-view').classList.toggle('d-none', compareOn);
  document.getElementById('compare-view').classList.toggle('d-none', !compareOn);
  btn.classList.toggle('active', compareOn);
  if (compareOn) loadCompare();
});

async function loadCompare() {
  const status = document.getElementById('cmp-status');
  if (!lastRows.length) {
    status.textContent = 'No local data selected — pick a period on the dashboard first.';
    return;
  }
  const from = lastRows[0].date;
  const to = lastRows[lastRows.length - 1].date;
  document.getElementById('cmp-range').textContent = `${from} → ${to}`;
  status.textContent = 'Loading public data…';

  let data;
  try {
    const r = await fetch(`/api/compare?from=${from}&to=${to}`);
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    data = await r.json();
  } catch (e) {
    status.textContent = `Could not fetch public data: ${e.message}`;
    return;
  }
  status.textContent = '';

  // Align public rows to my dates so both series share the same x-axis.
  const pub = new Map(data.public.map(p => [p.date, p]));
  const lbl = lastRows.map(r => r.date.slice(5));
  const mineOf = key => lastRows.map(r => r[key]);
  const pubOf  = key => lastRows.map(r => pub.get(r.date)?.[key] ?? null);

  const pair = (label, mineKey, pubKey) => ({
    labels: lbl,
    datasets: [
      { label: `Me · ${label}`,   data: mineOf(mineKey), borderColor: '#38bdf8', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3 },
      { label: `Baar · ${label}`, data: pubOf(pubKey),   borderColor: '#fb923c', backgroundColor: 'transparent', pointRadius: 2, tension: 0.3, borderDash: [5, 3] },
    ],
  });

  mkCmpChart('cmp-temp-high', 'line', pair('High', 'temp_high', 'temp_high'));
  mkCmpChart('cmp-temp-low',  'line', pair('Low',  'temp_low',  'temp_low'));
  mkCmpChart('cmp-wind',      'line', pair('Wind', 'wind_high', 'wind_high'));
  mkCmpChart('cmp-precip', 'bar', {
    labels: lbl,
    datasets: [
      { label: 'Me',   data: mineOf('precip'), backgroundColor: '#38bdf899' },
      { label: 'Baar', data: pubOf('precip'),  backgroundColor: '#fb923c99' },
    ],
  });

  renderCompareSummary(pub);
}

function renderCompareSummary(pub) {
  const avg = vals => {
    const v = vals.filter(x => x != null && !Number.isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const rows = [
    ['Temp High (°C)', 'temp_high'],
    ['Temp Low (°C)',  'temp_low'],
    ['Wind Max (km/h)','wind_high'],
    ['Precip (mm)',    'precip'],
  ];
  const fmt = n => (n == null ? '—' : n.toFixed(1));

  document.getElementById('cmp-summary-body').innerHTML = rows.map(([name, key]) => {
    const mine = avg(lastRows.map(r => r[key]));
    const theirs = avg(lastRows.map(r => pub.get(r.date)?.[key] ?? null));
    const diff = (mine != null && theirs != null) ? mine - theirs : null;
    const diffCls = diff == null ? '' : diff > 0 ? 'text-danger' : diff < 0 ? 'text-info' : '';
    const diffTxt = diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}`;
    return `<tr><td>${name}</td><td>${fmt(mine)}</td><td>${fmt(theirs)}</td><td class="${diffCls}">${diffTxt}</td></tr>`;
  }).join('');
}

// --- Init ---
(async () => {
  const resp = await fetch('/api/dates');
  allDates = await resp.json();
  renderControls();
  await load();
  await refreshStatus();
})();
