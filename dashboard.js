// Sky Café Trucks Dashboard – dashboard.js

// ─── Configuration ────────────────────────────────────────────────
const USER    = 'Inalgescodatalogger';
let DEVICE    = 'skycafe-1';
const POLL_MS = 10000;  // 10s between polls
const HIST    = 200;    // history length for charts
const TRAIL   = 50;     // points in map trail

// ─── Chart Colors ────────────────────────────────────────────────
const fallbackCols = ['#44b6f7', '#7cd992', '#e7c46c'];

// ─── Sensors ─────────────────────────────────────────────────────
const SENSORS = [
  { id: 'nr1', label: 'NR1 °F', col: getCSS('--g1', fallbackCols[0]), chart: null },
  { id: 'nr2', label: 'NR2 °F', col: getCSS('--g2', fallbackCols[1]), chart: null },
  { id: 'nr3', label: 'NR3 °F', col: getCSS('--g3', fallbackCols[2]), chart: null }
];

// ─── CSS Helper ──────────────────────────────────────────────────
function getCSS(varName, fallback = '') {
  return (getComputedStyle(document.documentElement)
    .getPropertyValue(varName) || '').trim() || fallback;
}

// ─── Feed Keys ───────────────────────────────────────────────────
function getFeeds(device) {
  return {
    gps:    `${device}.gps`,
    signal: `${device}.signal`,
    volt:   `${device}.volt`,
    speed:  `${device}.speed`,
    nr1:    `${device}.nr1`,
    nr2:    `${device}.nr2`,
    nr3:    `${device}.nr3`
  };
}

// ─── Fetch Utility ───────────────────────────────────────────────
// Handles both [ … ] and { data: [ … ] } responses
async function fetchFeed(feed, limit = 1, params = {}) {
  const proxy = 'https://rapid-mode-5c5a.peter-400.workers.dev';
  const url = new URL(`/proxy/api/v2/${USER}/feeds/${feed}/data`, proxy);
  url.searchParams.set('limit', limit);
  Object.entries(params).forEach(([k, v]) => v && url.searchParams.set(k, v));

  const res = await fetch(url);
  if (!res.ok) {
    console.error('Feed fetch failed', feed, res.status);
    return [];
  }
  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    console.error('Invalid JSON for', feed, e);
    return [];
  }
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : [];
  console.log(`→ ${feed}:`, arr.length, 'pts');
  return arr;
}

// ─── Formatting Utilities ────────────────────────────────────────
const fmt     = (v, p = 1) => v == null || isNaN(v) ? '–' : (+v).toFixed(p);
const isoHHMM = ts => ts ? ts.substring(11, 19) : '';

// ─── Charts Initialization ──────────────────────────────────────
function initCharts() {
  const container = document.getElementById('charts');
  container.innerHTML = '';
  SENSORS.forEach(sensor => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl shadow p-4 chart-box';
    card.innerHTML = `
      <h2 class="text-sm font-semibold mb-2">${sensor.label}</h2>
      <canvas></canvas>
    `;
    container.appendChild(card);
    const ctx = card.querySelector('canvas').getContext('2d');
    sensor.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: sensor.col, borderWidth: 2, tension: 0.25 }] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxRotation: 0 } },
          y: { min: 28, max: 122, grace: '5%' }
        }
      }
    });
  });
}

// ─── Map Initialization ──────────────────────────────────────────
let map, marker, poly, trail = [];
function initMap() {
  map = L.map('map').setView([0, 0], 2);
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; <a href="https://carto.com/">CARTO</a>' }
  ).addTo(map);
  marker = L.marker([0, 0]).addTo(map);
  poly    = L.polyline([], { weight: 3 }).addTo(map);
}

// ─── Update Historical Charts ────────────────────────────────────
async function updateCharts() {
  const feeds = getFeeds(DEVICE);
  await Promise.all(SENSORS.map(async s => {
    const rows = await fetchFeed(feeds[s.id], HIST);
    if (!rows.length) return;
    rows.reverse();
    s.chart.data.labels = rows.map(r => isoHHMM(r.created_at));
    s.chart.data.datasets[0].data = rows.map(r => {
      const n = parseFloat(r.value);
      return isNaN(n) ? null : n;
    });
    s.chart.update();
  }));
}

// ─── Draw Live Table & Map Trail ─────────────────────────────────
function drawLive({ ts, fix, lat, lon, alt, sats, signal, volt, speed, nr1, nr2, nr3 }) {
  document.getElementById('latest').innerHTML = [
    ['Local Time',    new Date(ts).toLocaleString()],
    ['Fix',           fix],
    ['Lat',           fmt(lat, 6)],
    ['Lon',           fmt(lon, 6)],
    ['Alt (m)',       fmt(alt, 1)],
    ['Sats',          fmt(sats, 0)],
    ['Speed (km/h)',  fmt(speed, 1)],
    ['RSSI (dBm)',    fmt(signal, 0)],
    ['Volt (mV)',     fmt(volt, 2)],
    ['NR1 °F',        fmt(nr1, 1)],
    ['NR2 °F',        fmt(nr2, 1)],
    ['NR3 °F',        fmt(nr3, 1)]
  ].map(([k, v]) => `<tr><th class="pr-2 text-left">${k}</th><td>${v}</td></tr>`).join('');

  // Always plot last known coordinates
  const latNum = Number(lat), lonNum = Number(lon);
  if (isFinite(latNum) && isFinite(lonNum)) {
    map.invalidateSize();
    marker.setLatLng([latNum, lonNum]);
    trail.push([latNum, lonNum]);
    if (trail.length > TRAIL) trail.shift();
    poly.setLatLngs(trail);
    map.setView([latNum, lonNum], Math.max(map.getZoom(), 13));
  }
}

// ─── Poll Loop for Live Data ────────────────────────────────────
async function poll() {
  const feeds = getFeeds(DEVICE);
  const [gpsA, sigA, voltA, spdA, n1A, n2A, n3A] = await Promise.all([
    fetchFeed(feeds.gps),    fetchFeed(feeds.signal),
    fetchFeed(feeds.volt),   fetchFeed(feeds.speed),
    fetchFeed(feeds.nr1),    fetchFeed(feeds.nr2),
    fetchFeed(feeds.nr3)
  ]);

  // Parse GPS JSON safely
  let g = { fix: false, lat: null, lon: null, alt: null, sats: null };
  try {
    if (gpsA[0]?.value) g = JSON.parse(gpsA[0].value);
  } catch (e) {
    console.warn('Bad GPS JSON', gpsA[0]?.value);
  }
  const pick = arr => {
    const v = arr[0]?.value;
    const n = parseFloat(v);
    return v != null && !isNaN(n) ? n : null;
  };

  const live = {
    ts:     gpsA[0]?.created_at,
    fix:    !!g.fix,
    lat:    g.lat,
    lon:    g.lon,
    alt:    g.alt,
    sats:   g.sats,
    signal: pick(sigA),
    volt:   pick(voltA),
    speed:  pick(spdA),
    nr1:    pick(n1A),
    nr2:    pick(n2A),
    nr3:    pick(n3A)
  };

  // Debug log live object:
  console.log('🔍 live object:', live);

  drawLive(live);

  // Append to charts
  [['nr1', live.nr1], ['nr2', live.nr2], ['nr3', live.nr3]].forEach(([id, val]) => {
    if (val == null) return;
    const s = SENSORS.find(x => x.id === id);
    s.chart.data.labels.push(isoHHMM(live.ts));
    s.chart.data.datasets[0].data.push(val);
    if (s.chart.data.labels.length > HIST) {
      s.chart.data.labels.shift();
      s.chart.data.datasets[0].data.shift();
    }
    s.chart.update();
  });

  setTimeout(poll, POLL_MS);
}

// ─── CSV Export Handler ─────────────────────────────────────────
document.getElementById('dlBtn').addEventListener('click', async () => {
  const start = document.getElementById('start').value;
  const end   = document.getElementById('end').value;
  if (!start || !end) {
    return document.getElementById('expStatus').textContent =
      'Please select both start and end dates.';
  }
  document.getElementById('expStatus').textContent = 'Fetching…';

  const feeds  = getFeeds(DEVICE);
  const params = {
    start: new Date(start).toISOString(),
    end:   new Date(end).toISOString()
  };

  const data = await Promise.all(
    Object.entries(feeds).map(async ([key, feed]) => {
      const rows = await fetchFeed(feed, 1000, params);
      return rows.map(r => ({ feed: key, ts: r.created_at, value: r.value }));
    })
  );

  // Flatten & sort
  const flat = data.flat().sort((a, b) => a.ts.localeCompare(b.ts));

  // Preview
  document.getElementById('preview').innerHTML = `
    <tr><th>Feed</th><th>Time</th><th>Value</th></tr>
    ${flat.slice(0,5).map(r => `
      <tr><td>${r.feed}</td><td>${r.ts}</td><td>${r.value}</td></tr>
    `).join('')}
  `;

  // Build & download CSV
  const rows = [
    ['feed','timestamp','value'],
    ...flat.map(r => [r.feed, r.ts, r.value])
  ];
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${DEVICE}_${start}_${end}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  document.getElementById('expStatus').textContent = 'Download ready.';
});

// ─── Device Selector & Bootstrap ─────────────────────────────────
document.getElementById('deviceSelect').addEventListener('change', e => {
  DEVICE = e.target.value;
  initCharts();
  updateCharts();
  trail = [];
});

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  updateCharts();
  initMap();
  poll();
});
