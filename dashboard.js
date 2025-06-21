// dashboard.js

// ─── Configuration ─────────────────────────────────────────────────────────────
const USER    = 'Inalgescodatalogger';
const AIO_KEY = 'aio_WsRe40ZXrrgYzdL0pldHUYjvxytH';    
let DEVICE    = 'skycafe-1';
const POLL_MS = 10000;             // 10 s between polls
const HIST    = 200;               // # of historical points to fetch
const TRAIL   = 50;                // # of points in the map trail

// ─── Helpers to build feed names & fetch data ──────────────────────────────────
function getFeeds(d) {
  return {
    gps:   `${d}.gps`,
    signal:`${d}.signal`,
    volt:  `${d}.volt`,
    speed: `${d}.speed`,
    nr1:   `${d}.nr1`,
    nr2:   `${d}.nr2`,
    nr3:   `${d}.nr3`
  };
}

async function fetchFeed(feed, limit = 1, params = {}) {
  const url = new URL(`https://io.adafruit.com/api/v2/${USER}/feeds/${feed}/data`);
  url.searchParams.set('limit', limit);
  for (let [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'X-AIO-Key': AIO_KEY } });
  return res.ok ? await res.json() : [];
}

// ─── Utility formatters ────────────────────────────────────────────────────────
const fmt = (v, p = 1) => v == null ? '–' : (+v).toFixed(p);
const isoHHMM = ts => ts.substring(11, 19);
const getProp = p => getComputedStyle(document.documentElement).getPropertyValue(p).trim();

// ─── Chart.js setup ────────────────────────────────────────────────────────────
const SENSORS = [
  { id: 'nr1', label: 'NR1 °F', col: getProp('--g1'), chart: null },
  { id: 'nr2', label: 'NR2 °F', col: getProp('--g2'), chart: null },
  { id: 'nr3', label: 'NR3 °F', col: getProp('--g3'), chart: null }
];

function initCharts() {
  const chartsDiv = document.getElementById('charts');
  SENSORS.forEach(s => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl shadow p-4 chart-box';
    card.innerHTML = `<h2 class="text-sm font-semibold mb-2">${s.label}</h2><canvas></canvas>`;
    chartsDiv.appendChild(card);
    const ctx = card.querySelector('canvas').getContext('2d');
    s.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, pointRadius: 0, tension: .25 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { maxRotation: 0 } }, y: { min: 20, max: 130 } }
      }
    });
  });
}

async function updateCharts() {
  const feeds = getFeeds(DEVICE);
  await Promise.all(SENSORS.map(async s => {
    const rows = await fetchFeed(feeds[s.id], HIST);
    if (!rows.length) return;
    rows.reverse();
    s.chart.data.labels = rows.map(r => isoHHMM(r.created_at));
    s.chart.data.datasets[0].data = rows.map(r => +r.value);
    s.chart.update();
  }));
}

// ─── Leaflet map setup ─────────────────────────────────────────────────────────
let map, marker, poly, path = [];
function initMap() {
  map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(map);
  marker = L.marker([0, 0]).addTo(map);
  poly   = L.polyline([], { weight: 3 }).addTo(map);
}

// ─── Draw the “Current Fix & Sensors” table & update map ───────────────────────
function drawLive({ ts, fix, lat, lon, alt, sats, signal, volt, speed, nr1, nr2, nr3 }) {
  const latest = document.getElementById('latest');
  latest.innerHTML = [
    ['Local Time', new Date(ts).toLocaleString()],
    ['Fix', fix],
    ['Lat', fmt(lat, 6)],
    ['Lon', fmt(lon, 6)],
    ['Alt (m)', fmt(alt,1)],
    ['Sats', sats],
    ['Speed (km/h)', fmt(speed,1)],
    ['RSSI (dBm)', signal],
    ['Volt (mV)', volt],
    ['NR1 °F', fmt(nr1,1)],
    ['NR2 °F', fmt(nr2,1)],
    ['NR3 °F', fmt(nr3,1)]
  ].map(r => `<tr><th class="text-left pr-2">${r[0]}</th><td>${r[1]}</td></tr>`).join('');

  if (fix && typeof lat === 'number' && typeof lon === 'number') {
    marker.setLatLng([lat, lon]);
    path.push([lat, lon]);
    if (path.length > TRAIL) path.shift();
    poly.setLatLngs(path);
    if (map.getZoom() < 5) map.setView([lat, lon], 13);
  }
}

// ─── Main polling loop ─────────────────────────────────────────────────────────
async function poll() {
  const feeds = getFeeds(DEVICE);
  // Parallel fetch
  const [gpsArr, sigArr, voltArr, spdArr, n1Arr, n2Arr, n3Arr] = await Promise.all([
    fetchFeed(feeds.gps),
    fetchFeed(feeds.signal),
    fetchFeed(feeds.volt),
    fetchFeed(feeds.speed),
    fetchFeed(feeds.nr1),
    fetchFeed(feeds.nr2),
    fetchFeed(feeds.nr3),
  ]);

  // Parse GPS JSON
  let g = { fix: false };
  try { g = JSON.parse(gpsArr[0]?.value || '{}'); }
  catch(e){ console.warn('Invalid GPS JSON', gpsArr[0]?.value); }

  // Build live data object
  const live = {
    ts:        gpsArr[0]?.created_at,
    fix:       g.fix ?? false,
    lat:       g.lat,
    lon:       g.lon,
    alt:       g.alt,
    sats:      g.sats,
    signal:    sigArr[0]?.value,
    volt:      voltArr[0]?.value,
    speed:     spdArr[0]?.value,
    nr1:       n1Arr[0]?.value,
    nr2:       n2Arr[0]?.value,
    nr3:       n3Arr[0]?.value
  };

  // Render table & map
  drawLive(live);

  // Push new points onto charts
  [['nr1', live.nr1], ['nr2', live.nr2], ['nr3', live.nr3]].forEach(([id, val]) => {
    const s = SENSORS.find(x => x.id === id);
    if (!s || val == null) return;
    const c = s.chart;
    c.data.labels.push(isoHHMM(live.ts));
    c.data.datasets[0].data.push(+val);
    if (c.data.labels.length > HIST) {
      c.data.labels.shift();
      c.data.datasets[0].data.shift();
    }
    c.update();
  });

  setTimeout(poll, POLL_MS);
}

// ─── Device selector handler ───────────────────────────────────────────────────
document.getElementById('deviceSelect').addEventListener('change', e => {
  DEVICE = e.target.value;
  updateCharts();
});

// ─── Startup ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  updateCharts();
  initMap();
  poll();
});
