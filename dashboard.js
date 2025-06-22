// dashboard.js

// ─── Configuration ─────────────────────────────────────────────────────────────
const USER    = 'inalgescodatalogger';
const AIO_KEY = 'aio_WsRe40ZXrrgYzdL0pldHUYjvxytH';    // ← your real key
let DEVICE    = 'skycafe-1';
const POLL_MS = 10000;   // 10 s between polls
const HIST    = 200;     // how many historical points charts fetch
const TRAIL   = 50;      // how many points to keep in the map trail

// ─── Helpers ───────────────────────────────────────────────────────────────────
function getFeeds(d) {
  return {
    gps:    `${d}.gps`,       // ← correct (dot)
    signal: `${d}.signal`,
    volt:   `${d}.volt`,
    speed:  `${d}.speed`,
    nr1:    `${d}.nr1`,
    nr2:    `${d}.nr2`,
    nr3:    `${d}.nr3`
  };
}


async function fetchFeed(feed, limit = 1, params = {}) {
  // Build URL against our proxied subdomain
  const url = new URL(
    `https://api.skycafetrucks.com/api/v2/${USER}/feeds/${feed}/data`
  );
  url.searchParams.set('limit', limit);

  // Move the key into the query string—no custom headers needed, so no preflight
  url.searchParams.set('x-aio-key', AIO_KEY);

  // A plain GET now, with CORS allowed by our Transform Rule
  const res = await fetch(url.toString());
  if (!res.ok) {
    console.error('Adafruit IO error', res.status, await res.text());
    return [];
  }
  return res.json();
}




const fmt = (v, p = 1) => v == null ? '–' : (+v).toFixed(p);
const isoHHMM = ts => ts.substring(11, 19);
const getProp = p => getComputedStyle(document.documentElement).getPropertyValue(p).trim();

// ─── Chart.js Setup ────────────────────────────────────────────────────────────
const SENSORS = [
  { id: 'nr1', label: 'NR1 °F', col: getProp('--g1'), chart: null },
  { id: 'nr2', label: 'NR2 °F', col: getProp('--g2'), chart: null },
  { id: 'nr3', label: 'NR3 °F', col: getProp('--g3'), chart: null }
];

function initCharts() {
  const chartsDiv = document.getElementById('charts');
  chartsDiv.innerHTML = '';  // clear any old
  SENSORS.forEach(s => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl shadow p-4 chart-box';
    card.innerHTML = `<h2 class="text-sm font-semibold mb-2">${s.label}</h2><canvas></canvas>`;
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
          y: {
            min: 28,
            max: 122,
            grace: '5%'
          }
        }
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

// ─── Leaflet Map Setup ─────────────────────────────────────────────────────────
let map, marker, poly, path = [];
function initMap() {
  map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(map);
  marker = L.marker([0, 0]).addTo(map);
  poly   = L.polyline([], { weight: 3 }).addTo(map);
}

// ─── Draw Live Table & Trail ───────────────────────────────────────────────────
function drawLive(data) {
  const {
    ts, fix, lat, lon, alt, sats,
    signal, volt, speed, nr1, nr2, nr3
  } = data;

  document.getElementById('latest').innerHTML = [
    ['Local Time', new Date(ts).toLocaleString()],
    ['Fix', fix],
    ['Lat', fmt(lat, 6)],
    ['Lon', fmt(lon, 6)],
    ['Alt (m)', fmt(alt,1)],
    ['Sats', sats],
    ['Speed (km/h)', fmt(speed,1)],
    ['RSSI (dBm)', fmt(signal,0)],
    ['Volt (mV)', fmt(volt,0)],
    ['NR1 °F', fmt(nr1,1)],
    ['NR2 °F', fmt(nr2,1)],
    ['NR3 °F', fmt(nr3,1)]
  ].map(r => `<tr><th class="pr-2 text-left">${r[0]}</th><td>${r[1]}</td></tr>`).join('');

  if (fix && typeof lat === 'number' && typeof lon === 'number') {
    marker.setLatLng([lat, lon]);
    path.push([lat, lon]);
    if (path.length > TRAIL) path.shift();
    poly.setLatLngs(path);
    map.setView([lat, lon], Math.max(map.getZoom(), 13));
  }
}

// ─── Main Loop ─────────────────────────────────────────────────────────────────
async function poll() {
  const feeds = getFeeds(DEVICE);
  console.log('🔍 poll(): feeds =', feeds);
  const [gpsArr, sigArr, voltArr, spdArr, n1Arr, n2Arr, n3Arr] = await Promise.all([
    fetchFeed(feeds.gps),
    fetchFeed(feeds.signal),
    fetchFeed(feeds.volt),
    fetchFeed(feeds.speed),
    fetchFeed(feeds.nr1),
    fetchFeed(feeds.nr2),
    fetchFeed(feeds.nr3),
  ]);

  // parse GPS JSON
  let g = { fix: false };
  try { g = JSON.parse(gpsArr[0]?.value || '{}'); }
  catch(e){ console.warn('Invalid GPS JSON', gpsArr[0]?.value); }

  const live = {
    ts:    gpsArr[0]?.created_at,
    fix:   !!g.fix,
    lat:   g.lat,
    lon:   g.lon,
    alt:   g.alt,
    sats:  g.sats,
    signal:+sigArr[0]?.value || 0,
    volt:  +voltArr[0]?.value || 0,
    speed: +spdArr[0]?.value || 0,
    nr1:   +n1Arr[0]?.value || null,
    nr2:   +n2Arr[0]?.value || null,
    nr3:   +n3Arr[0]?.value || null
  };

  drawLive(live);

  // update charts with point-by-point push
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

// ─── Device Selector & Init ────────────────────────────────────────────────────
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
