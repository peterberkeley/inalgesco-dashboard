// ─── Configuration ────────────────────────────────────────────────
const USER    = 'Inalgescodatalogger';
let DEVICE    = 'skycafe-1';
const POLL_MS = 10000;  // 10s between polls
const HIST    = 200;    // Chart history length
const TRAIL   = 50;     // Map trail points

// ─── Chart Colors: fallback if CSS vars missing ──────────────────
const fallbackCols = ['#44b6f7', '#7cd992', '#e7c46c'];

// ─── Sensor Definitions ──────────────────────────────────────────
const SENSORS = [
  { id: 'nr1', label: 'NR1 °F', col: getCSS('--g1', fallbackCols[0]), chart: null },
  { id: 'nr2', label: 'NR2 °F', col: getCSS('--g2', fallbackCols[1]), chart: null },
  { id: 'nr3', label: 'NR3 °F', col: getCSS('--g3', fallbackCols[2]), chart: null }
];

// ─── CSS Helper ──────────────────────────────────────────────────
function getCSS(varName, fallback = '') {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
}

// ─── Feed Paths ──────────────────────────────────────────────────
function getFeeds(d) {
  return {
    gps:    `${d}.gps`,
    signal: `${d}.signal`,
    volt:   `${d}.volt`,
    speed:  `${d}.speed`,
    nr1:    `${d}.nr1`,
    nr2:    `${d}.nr2`,
    nr3:    `${d}.nr3`
  };
}

// ─── Fetch Utility ───────────────────────────────────────────────
async function fetchFeed(feed, limit = 1, params = {}) {
  const proxyOrigin = 'https://rapid-mode-5c5a.peter-400.workers.dev';
  const url = new URL(`/proxy/api/v2/${USER}/feeds/${feed}/data`, proxyOrigin);
  url.searchParams.set('limit', limit);
  Object.entries(params).forEach(([k, v]) => v && url.searchParams.set(k, v));

  const res = await fetch(url.toString());
  if (!res.ok) {
    console.error('Feed fetch failed:', res.status, await res.text());
    return [];
  }
  return res.json();
}

// ─── Formatting Utilities ────────────────────────────────────────
const fmt = (v, p = 1) => v == null ? '–' : (+v).toFixed(p);
const isoHHMM = ts => ts ? ts.substring(11, 19) : '';

// ─── Chart.js Initialization ─────────────────────────────────────
function initCharts() {
  const chartsDiv = document.getElementById('charts');
  chartsDiv.innerHTML = '';
  SENSORS.forEach((s, idx) => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl shadow p-4 chart-box';
    card.style.height = '320px'; // fixed height for stability
    card.innerHTML = `<h2 class="text-sm font-semibold mb-2">${s.label}</h2><canvas style="height:260px!important"></canvas>`;
    chartsDiv.appendChild(card);

    const ctx = card.querySelector('canvas').getContext('2d');
    s.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: s.col,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25
        }]
      },
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

// ─── Chart Updater ───────────────────────────────────────────────
async function updateCharts() {
  const feeds = getFeeds(DEVICE);
  await Promise.all(SENSORS.map(async s => {
    const rows = await fetchFeed(feeds[s.id], HIST);
    if (!rows.length) return;
    rows.reverse();
    s.chart.data.labels = rows.map(r => isoHHMM(r.created_at));
    s.chart.data.datasets[0].data = rows.map(r => {
      // Force to number if possible (handles string/number/null)
      const v = r.value;
      return v == null ? null : +v;
    });
    s.chart.update();
  }));
}

// ─── Leaflet Map Setup ───────────────────────────────────────────
let map, marker, poly, path = [];
function initMap() {
  map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(map);
  marker = L.marker([0, 0]).addTo(map);
  poly   = L.polyline([], { weight: 3 }).addTo(map);
}

// ─── Draw Live Table & Map Trail ─────────────────────────────────
function drawLive(data) {
  const { ts, fix, lat, lon, alt, sats, signal, volt, speed, nr1, nr2, nr3 } = data;

  document.getElementById('latest').innerHTML = [
    ['Local Time', new Date(ts).toLocaleString()],
    ['Fix', fix],
    ['Lat', fmt(lat, 6)],
    ['Lon', fmt(lon, 6)],
    ['Alt (m)', fmt(alt, 1)],
    ['Sats', sats],
    ['Speed (km/h)', fmt(speed, 1)],
    ['RSSI (dBm)', fmt(signal, 0)],
    ['Volt (mV)', fmt(volt, 0)],
    ['NR1 °F', fmt(nr1, 1)],
    ['NR2 °F', fmt(nr2, 1)],
    ['NR3 °F', fmt(nr3, 1)]
  ].map(r => `<tr><th class="pr-2 text-left">${r[0]}</th><td>${r[1]}</td></tr>`).join('');

  // Show on map if sats > 1, regardless of fix
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if ((sats > 1) && !isNaN(latNum) && !isNaN(lonNum)) {
    marker.setLatLng([latNum, lonNum]);         // <- ALWAYS [lat, lon]!
    path.push([latNum, lonNum]);
    if (path.length > TRAIL) path.shift();
    poly.setLatLngs(path);
    map.setView([latNum, lonNum], Math.max(map.getZoom(), 13));
  }
}

// ─── Poll Loop ──────────────────────────────────────────────────
async function poll() {
  const feeds = getFeeds(DEVICE);
  const [gpsArr, sigArr, voltArr, spdArr, n1Arr, n2Arr, n3Arr] = await Promise.all([
    fetchFeed(feeds.gps),
    fetchFeed(feeds.signal),
    fetchFeed(feeds.volt),
    fetchFeed(feeds.speed),
    fetchFeed(feeds.nr1),
    fetchFeed(feeds.nr2),
    fetchFeed(feeds.nr3)
  ]);
  let g = { fix: false };
  try { g = JSON.parse(gpsArr[0]?.value || '{}'); }
  catch (e) { console.warn('Invalid GPS JSON', gpsArr[0]?.value); }

  // Fix: if lat/lon are present as strings, force to numbers
  const latNum = g.lat !== undefined ? Number(g.lat) : undefined;
  const lonNum = g.lon !== undefined ? Number(g.lon) : undefined;

  const live = {
    ts:    gpsArr[0]?.created_at,
    fix:   g.fix !== undefined ? !!g.fix : (!isNaN(latNum) && !isNaN(lonNum)),
    lat:   latNum,
    lon:   lonNum,
    alt:   g.alt !== undefined ? Number(g.alt) : undefined,
    sats:  g.sats !== undefined ? Number(g.sats) : undefined,
    signal: +sigArr[0]?.value || 0,
    volt:  +voltArr[0]?.value || 0,
    speed: +spdArr[0]?.value || 0,
    nr1:   n1Arr[0]?.value != null ? +n1Arr[0].value : null,
    nr2:   n2Arr[0]?.value != null ? +n2Arr[0].value : null,
    nr3:   n3Arr[0]?.value != null ? +n3Arr[0].value : null
  };

  drawLive(live);

  // Stable, fixed-size chart update
  [['nr1', live.nr1], ['nr2', live.nr2], ['nr3', live.nr3]].forEach(([id, val]) => {
    const s = SENSORS.find(x => x.id === id);
    if (!s || val == null) return;
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

// ─── Device Selector & Init ─────────────────────────────────────
document.getElementById('deviceSelect').addEventListener('change', e => {
  DEVICE = e.target.value;
  initCharts();
  updateCharts();
  path = [];
});

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  updateCharts();
  initMap();
  poll();
});
