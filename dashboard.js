// dashboard.js — Added ICCID display
(() => {
  // [0] THEME COLORS & SPINNER UTILS
  const COLORS = {
    primary: getCSS('--color-primary'),
    secondary: getCSS('--color-secondary'),
    accent: getCSS('--color-accent'),
    text: getCSS('--color-text'),
    card: getCSS('--color-card')
  };
  const spinner = document.getElementById('spinner');
  function showSpinner() { spinner.style.display = 'block'; }
  function hideSpinner() { spinner.style.display = 'none'; }

  // [1] CONFIG
  const USER = 'Inalgescodatalogger';
  let DEVICE = 'skycafe-1';
  const POLL_MS = 10000;
  const HIST = 50;
  const TRAIL = 50;
  const lastTs = { nr1: null, nr2: null, nr3: null, signal: null, volt: null, speed: null, iccid: null };

  // [2] SENSORS & ICCID
  const SENSORS = [
    { id: 'nr1', label: 'NR1 °F',   col: getCSS('--g1', COLORS.primary),   chart: null },
    { id: 'nr2', label: 'NR2 °F',   col: getCSS('--g2', COLORS.secondary), chart: null },
    { id: 'nr3', label: 'NR3 °F',   col: getCSS('--g3', COLORS.accent),    chart: null },
    { id: 'signal', label: 'RSSI (dBm)', col: getCSS('--g4', '#999'),        chart: null },
    { id: 'volt',   label: 'Volt (mV)',  col: getCSS('--g5', '#666'),        chart: null },
    { id: 'speed',  label: 'Speed (km/h)', col: getCSS('--g6', '#333'),      chart: null }
  ];

  // [3] CSS HELPER
  function getCSS(varName, fallback = '') {
    return (getComputedStyle(document.documentElement)
      .getPropertyValue(varName) || '').trim() || fallback;
  }

  // [4] FEEDS
  function getFeeds(device) {
    return {
      gps:    `${device}.gps`,    signal: `${device}.signal`,
      volt:   `${device}.volt`,   speed:  `${device}.speed`,
      nr1:    `${device}.nr1`,     nr2:    `${device}.nr2`,
      nr3:    `${device}.nr3`,     iccid:  `${device}.iccid`
    };
  }

  // [5] FETCH UTILITY
  async function fetchFeed(feedKey, limit = 1, params = {}) {
    const url = new URL(`https://io.adafruit.com/api/v2/${USER}/feeds/${feedKey}/data`);
    url.searchParams.set('limit', limit);
    Object.entries(params).forEach(([k, v]) => v && url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) { console.error(`Fetch failed [${feedKey}]:`, res.status); return []; }
    const body = await res.json();
    return Array.isArray(body)
      ? body
      : Array.isArray(body.data)
        ? body.data
        : [];
  }

  // [6] FORMATTING
  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);
  const formatTime12h = ts => ts
    ? new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    : '';

  // [7] INIT CHARTS
  function initCharts() {
    const ctr = document.getElementById('charts'); ctr.innerHTML = '';
    SENSORS.forEach(s => {
      const card = document.createElement('div'); card.className = 'chart-box';
      card.innerHTML = `<h2>${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx = card.querySelector('canvas').getContext('2d');
      s.chart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, tension: 0.25 }] },
        options: {
          animation: false, responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              backgroundColor: COLORS.card,
              titleColor: COLORS.text,
              bodyColor: COLORS.text,
              borderColor: 'rgba(0,0,0,0.1)', borderWidth: 1,
              callbacks: {
                title: items => items[0]?.raw?.fullTime || '',
                label: ctx => `Value: ${ctx.formattedValue}`
              }
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { maxRotation: 0, color: COLORS.text } },
            y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: COLORS.text }, grace: '5%' }
          }
        }
      });
    });
  }

  // [8] INIT MAP
  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      { attribution: '© CARTO' }
    ).addTo(map);
    marker = L.marker([0, 0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ metric: true, imperial: false }).addTo(map);
  }

  // [9] UPDATE HISTORICAL — no conversion
  async function updateCharts() {
    const feeds = getFeeds(DEVICE);
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchFeed(feeds[s.id], HIST);
      if (!rows.length) return;
      rows.reverse();
      const dataObjs = rows.map(r => ({
        x: formatTime12h(r.created_at),
        y: isNaN(parseFloat(r.value)) ? null : +parseFloat(r.value).toFixed(1),
        fullTime: new Date(r.created_at).toLocaleString()
      }));
      s.chart.data.labels = dataObjs.map(d => d.x);
      s.chart.data.datasets[0].data = dataObjs;
      s.chart.update();
    }));
  }

  // [10] DRAW LIVE & ICCID & APPEND
  function drawLive(data) {
    const { ts, lat, lon, signal, volt, speed, nr1, nr2, nr3, iccid } = data;
    document.getElementById('latest').innerHTML =
      [[ 'Local Time', new Date(ts).toLocaleString() ],
       [ 'ICCID', iccid || '–' ],
       [ 'Lat', fmt(lat, 6) ], [ 'Lon', fmt(lon, 6) ],
       [ 'Speed (km/h)', fmt(speed, 1) ], [ 'RSSI (dBm)', fmt(signal, 0) ], [ 'Volt (mV)', fmt(volt, 2) ],
       [ 'NR1 °F', fmt(nr1, 1) ], [ 'NR2 °F', fmt(nr2, 1) ], [ 'NR3 °F', fmt(nr3, 1) ]
      ].map(([k, v]) => `<tr><th class="pr-2 text-left">${k}</th><td>${v}</td></tr>`).join('');
    const latN = Number(lat), lonN = Number(lon);
    if (isFinite(latN) && isFinite(lonN)) {
      map.invalidateSize(); marker.setLatLng([latN, lonN]); trail.push([latN, lonN]);
      if (trail.length > TRAIL) trail.shift(); polyline.setLatLngs(trail);
      map.setView([latN, lonN], Math.max(map.getZoom(), 13));
    }
  }

  // [11] POLL LOOP — include ICCID fetch
  async function poll() {
    const feeds = getFeeds(DEVICE);
    const [gpsA, sA, vA, spA, n1A, n2A, n3A, icA] = await Promise.all([
      fetchFeed(feeds.gps), fetchFeed(feeds.signal), fetchFeed(feeds.volt), fetchFeed(feeds.speed),
      fetchFeed(feeds.nr1), fetchFeed(feeds.nr2), fetchFeed(feeds.nr3), fetchFeed(feeds.iccid)
    ]);
    let g = { lat: null, lon: null };
    try { if (gpsA[0]?.value) g = JSON.parse(gpsA[0].value); } catch {}
    const pick = arr => { const v = arr[0]?.value, n = parseFloat(v); return (v != null && !isNaN(n)) ? n : null; };
    const live = {
      ts:    gpsA[0]?.created_at,
      lat:   g.lat, lon: g.lon,
      signal: pick(sA), volt: pick(vA), speed: pick(spA),
      nr1:   pick(n1A), nr2: pick(n2A), nr3: pick(n3A),
      iccid: icA[0]?.value || null
    };
    drawLive(live);
    SENSORS.forEach(s => {
      const val = live[s.id]; if (val == null || live.ts === lastTs[s.id]) return;
      const obj = { x: formatTime12h(live.ts), y: val, fullTime: new Date(live.ts).toLocaleString() };
      s.chart.data.labels.push(obj.x);
      s.chart.data.datasets[0].data.push(obj);
      lastTs[s.id] = live.ts;
      if (s.chart.data.datasets[0].data.length > HIST) {
        s.chart.data.labels.shift(); s.chart.data.datasets[0].data.shift();
      }
      s.chart.update();
    });
    setTimeout(poll, POLL_MS);
  }

  // [12] CSV EXPORT (unchanged)
  document.getElementById('dlBtn').addEventListener('click', async (ev) => {
    ev.preventDefault();
    /* ... existing export code ... */
  });

  // [13] BOOTSTRAP
  document.getElementById('deviceSelect').addEventListener('change', e => { DEVICE = e.target.value; initCharts(); updateCharts(); });
  document.addEventListener('DOMContentLoaded', async () => { showSpinner(); initCharts(); await updateCharts(); initMap(); hideSpinner(); poll(); });
})();
