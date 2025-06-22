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
    s.chart.data.datasets[0].data = rows.map(r => +r.value);
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
  const { ts, fix, lat, lon, alt, sats, signal, volt, spee
