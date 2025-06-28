// dashboard.js — Fully hardcoded skycafe-1 through skycafe-24
(() => {
  // [0] THEME COLORS & SPINNER UTILITIES
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
  const USER    = 'Inalgescodatalogger';
  const POLL_MS = 10000;
  const HIST    = 50;
  const TRAIL   = 50;
  const lastTs  = { nr1: null, nr2: null, nr3: null, signal: null, volt: null, speed: null, iccid: null };

  // [1a] STATIC DEVICE LIST (skycafe-1 through skycafe-24)
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = DEVICES[0];

  // [2] SENSORS & ICCID
  const SENSORS = [
    { id: 'nr1',    label: 'NR1 °F',       col: getCSS('--g1', COLORS.primary),   chart: null },
    { id: 'nr2',    label: 'NR2 °F',       col: getCSS('--g2', COLORS.secondary), chart: null },
    { id: 'nr3',    label: 'NR3 °F',       col: getCSS('--g3', COLORS.accent),    chart: null },
    { id: 'signal', label: 'RSSI (dBm)',   col: getCSS('--g4', '#999'),            chart: null },
    { id: 'volt',   label: 'Volt (mV)',    col: getCSS('--g5', '#666'),            chart: null },
    { id: 'speed',  label: 'Speed (km/h)', col: getCSS('--g6', '#333'),            chart: null }
  ];

  // [3] CSS HELPER
  function getCSS(varName, fallback = '') {
    return (getComputedStyle(document.documentElement)
      .getPropertyValue(varName) || '').trim() || fallback;
  }

  // [4] FEEDS per device
  function getFeeds(device) {
    return {
      gps:    `${device}.gps`,
      signal: `${device}.signal`,
      volt:   `${device}.volt`,
      speed:  `${device}.speed`,
      nr1:    `${device}.nr1`,
      nr2:    `${device}.nr2`,
      nr3:    `${device}.nr3`,
      iccid:  `${device}.iccid`
    };
  }

  // [5] FETCH UTILITY
  async function fetchFeed(feedKey, limit = 1, params = {}) {
    const url = new URL(`https://io.adafruit.com/api/v2/${USER}/feeds/${feedKey}/data`);
    url.searchParams.set('limit', limit);
    Object.entries(params).forEach(([k, v]) => v && url.searchParams.set(k, v));
    const res = await fetch(url);
    if (!res.ok) { console.error(`Fetch failed [${feedKey}]:`, res.status); return [];}    
    const json = await res.json();
    return Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
  }

  // [6] FORMAT HELPERS
  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);
  const formatTime12h = ts => ts
    ? new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    : '';

  // [7] INIT CHARTS
  function initCharts() {
    const ctr = document.getElementById('charts');
    ctr.innerHTML = '';
    SENSORS.forEach(s => {
      const card = document.createElement('div');
      card.className = 'chart-box';
      card.innerHTML = `<h2>${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx = card.querySelector('canvas').getContext('2d');
      s.chart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, tension: 0.25 }] },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              backgroundColor: COLORS.card,
              titleColor: COLORS.text,
              bodyColor: COLORS.text,
              borderColor: 'rgba(0,0,0,0.1)',
              borderWidth: 1,
              callbacks: {
                title: items => items[0]?.raw?.fullTime || '',
                label: ctx => `Value: ${ctx.formattedValue}`
              }
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: COLORS.text } },
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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '© CARTO' }).addTo(map);
    marker = L.marker([0, 0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ metric: true, imperial: false }).addTo(map);
  }

  // [9] UPDATE HISTORICAL DATA
  async function updateCharts() {
    const feeds = getFeeds(DEVICE);
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchFeed(feeds[s.id], HIST);
      if (!rows.length) return;
      rows.reverse();
      const labels = rows.map(r => formatTime12h(r.created_at));
      const values = rows.map(r => { const n = parseFloat(r.value); return isNaN(n) ? null : n; });
      s.chart.data.labels = labels;
      s.chart.data.datasets[0].data = values;
      s.chart.update();
    }));
  }

  // [10] DRAW LIVE & ICCID
  function drawLive(data) {
    const { ts, lat, lon, signal, volt, speed, nr1, nr2, nr3, iccid } = data;
    const rows = [
      ['Local Time', new Date(ts).toLocaleString()],
      ['ICCID', iccid || '–'],
      ['Lat', fmt(lat, 6)],
      ['Lon', fmt(lon, 6)],
      ['Speed (km/h)', fmt(speed, 1)],
      ['RSSI (dBm)', fmt(signal, 0)],
      ['Volt (mV)', fmt(volt, 2)],
      ['NR1 °F', fmt(nr1, 1)],
      ['NR2 °F', fmt(nr2, 1)],
      ['NR3 °F', fmt(nr3, 1)]
    ];
    document.getElementById('latest').innerHTML = rows.map(r => `<tr><th class="pr-2 text-left">${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if (isFinite(lat) && isFinite(lon)) {
      map.invalidateSize();
      marker.setLatLng([lat, lon]);
      trail.push([lat, lon]);
      if (trail.length > TRAIL) trail.shift();
      polyline.setLatLngs(trail);
      map.setView([lat, lon], Math.max(map.getZoom(), 13));
    }
  }

  // [11] POLL LOOP
  async function poll() {
    const feeds = getFeeds(DEVICE);
    const [gpsA, sigA, voltA, spA, n1A, n2A, n3A, icA] = await Promise.all([
      fetchFeed(feeds.gps), fetchFeed(feeds.signal), fetchFeed(feeds.volt), fetchFeed(feeds.speed),
      fetchFeed(feeds.nr1), fetchFeed(feeds.nr2), fetchFeed(feeds.nr3), fetchFeed(feeds.iccid)
    ]);
    let lat = 0, lon = 0;
    try { const g = JSON.parse(gpsA[0]?.value); lat = g.lat; lon = g.lon; } catch {}
    const pick = arr => { const v = arr[0]?.value; const n = parseFloat(v); return isNaN(n) ? null : n; };
    const live = { ts: gpsA[0]?.created_at, lat, lon, signal: pick(sigA), volt: pick(voltA), speed: pick(spA), nr1: pick(n1A), nr2: pick(n2A), nr3: pick(n3A), iccid: icA[0]?.value || null };
    drawLive(live);
    SENSORS.forEach(s => {
      const val = live[s.id]; if (val == null) return;
      s.chart.data.labels.push(formatTime12h(live.ts));
      s.chart.data.datasets[0].data.push(val);
      if (s.chart.data.datasets[0].data.length > HIST) {
        s.chart.data.labels.shift();
        s.chart.data.datasets[0].data.shift();
      }
      s.chart.update();
    });
    setTimeout(poll, POLL_MS);
  }

  // [12] CSV EXPORT (unchanged)
  document.getElementById('dlBtn').addEventListener('click', async ev => { ev.preventDefault(); /* existing export */ });

  // [13] BOOTSTRAP
  document.addEventListener('DOMContentLoaded', () => {
    const deviceSelect = document.getElementById('deviceSelect');
    DEVICES.forEach(dev => {
      const opt = document.createElement('option');
      opt.value = dev;
      opt.text = dev.replace('skycafe-', 'SkyCafé ');
      deviceSelect.appendChild(opt);
    });
    DEVICE = deviceSelect.value;
    deviceSelect.addEventListener('change', e => { DEVICE = e.target.value; initCharts(); updateCharts(); });
    showSpinner();
    initCharts();
    updateCharts().then(() => { initMap(); hideSpinner(); poll(); });
  });
})();
