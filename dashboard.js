// dashboard.js

const USER     = 'Inalgescodatalogger';
const AIO_KEY  = 'YOUR_AIO_KEY'; // ← replace with your real key
let DEVICE     = 'skycafe-1';
const POLL_MS  = 10000;
const HIST     = 200;
const TRAIL    = 50;

const getFeeds = d => ({
  gps:   `${d}.gps`,
  signal:`${d}.signal`,
  volt:  `${d}.volt`,
  speed: `${d}.speed`,
  nr1:   `${d}.nr1`,
  nr2:   `${d}.nr2`,
  nr3:   `${d}.nr3`
});

async function fetchFeed(feed, limit=1, params={}) {
  const url = new URL(`https://io.adafruit.com/api/v2/${USER}/feeds/${feed}/data`);
  url.searchParams.set('limit', limit);
  Object.entries(params).forEach(([k,v]) => v && url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'X-AIO-Key': AIO_KEY } });
  return res.ok ? res.json() : [];
}

// TODO: initialize Chart.js charts and Leaflet map here

(async function poll() {
  const feeds = getFeeds(DEVICE);
  const gpsData = await fetchFeed(feeds.gps);
  console.log('Latest GPS:', gpsData);
  setTimeout(poll, POLL_MS);
})();
// --- chart setup ---

// Define the sensors we’ll plot
const SENSORS = [
  { id: 'nr1', label: 'NR1 °F', chart: null },
  { id: 'nr2', label: 'NR2 °F', chart: null },
  { id: 'nr3', label: 'NR3 °F', chart: null }
];

// Create a Chart for each sensor in the #charts container
function initCharts() {
  const chartsDiv = document.getElementById('charts');
  SENSORS.forEach(s => {
    // Create card div
    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl shadow p-4 chart-box';
    card.innerHTML = `<h2 class="text-sm font-semibold mb-2">${s.label}</h2><canvas></canvas>`;
    chartsDiv.appendChild(card);

    // Initialize Chart.js
    const ctx = card.querySelector('canvas').getContext('2d');
    s.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], tension: 0.25, pointRadius: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: true },
          y: { display: true, min: 20, max: 130 }
        }
      }
    });
  });
}

// Call initCharts() once at load
initCharts();
