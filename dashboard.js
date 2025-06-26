<!DOCTYPE html>
<html lang="en" class="theme-light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sky Café Trucks Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.7.1/dist/leaflet.css" />
  <style>
    :root {
      --color-bg: #f9fafb;
      --color-card: #ffffff;
      --color-primary: #44b6f7;
      --color-accent: #7cd992;
      --color-text: #333333;
      --space: 1rem;
      --font-base: 16px;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--color-bg);
      color: var(--color-text);
      font-size: var(--font-base);
      font-family: sans-serif;
    }
    #controls {
      display: flex;
      gap: var(--space);
      padding: var(--space);
      flex-wrap: wrap;
      background: var(--color-card);
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    #charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: var(--space);
      padding: var(--space);
    }
    .chart-box {
      background: var(--color-card);
      border-radius: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      padding: var(--space);
      aspect-ratio: 16 / 9;
      position: relative;
      overflow: hidden;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .chart-box:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 10px rgba(0,0,0,0.1);
    }
    canvas { width: 100%; height: 100%; }
    #map { width: 100%; height: 400px; aspect-ratio: 4 / 3; margin: var(--space); border-radius: 1rem; }
    #latest { width: 100%; border-collapse: collapse; margin: var(--space); }
    #latest th, #latest td { padding: 0.5rem; text-align: left; }
    #latest tr:hover { background: #eee; }
    .btn, input, select {
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      border: 1px solid #ccc;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
      font-size: 1rem;
      transition: background 0.15s ease, box-shadow 0.15s ease;
    }
    .btn {
      background: var(--color-primary);
      color: white;
      cursor: pointer;
    }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn:hover:not(:disabled) { background: #3aa0e0; }
    .btn:focus, input:focus, select:focus { outline: none; box-shadow: 0 0 0 3px var(--color-primary); }
    .skeleton {
      background: #ddd;
      position: absolute; top: 0; left: 0;
      width: 100%; height: 100%;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .no-data {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #999;
      font-size: 1rem;
    }
  </style>
</head>
<body>
  <div id="controls">
    <label>
      Device:
      <select id="deviceSelect" class="btn">
        <option value="skycafe-1">skycafe-1</option>
        <option value="skycafe-2">skycafe-2</option>
      </select>
    </label>
    <label>
      Start:
      <input type="date" id="start">
    </label>
    <label>
      End:
      <input type="date" id="end">
    </label>
    <button id="dlBtn" class="btn">Download CSV</button>
    <span id="expStatus"></span>
  </div>

  <div id="charts"></div>
  <div id="map"></div>
  <table id="latest"></table>

  <script src="https://unpkg.com/leaflet@1.7.1/dist/leaflet.js"></script>
  <script>
    // CONFIGURATION
    const USER = 'Inalgescodatalogger';
    let DEVICE = 'skycafe-1';
    const POLL_MS = 10000;
    const HIST = 50;
    const TRAIL = 50;
    const lastTs = { nr1:null, nr2:null, nr3:null, signal:null, volt:null, speed:null };

    // CSS HELPER
    function getCSS(varName, fallback = '') {
      return (getComputedStyle(document.documentElement)
        .getPropertyValue(varName) || '').trim() || fallback;
    }

    // FORMATTING
    const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);
    const isoHHMM = ts => ts ? ts.substring(11, 16) : '';

    // FETCH UTILITY
    async function fetchFeed(feedKey, limit = 1, params = {}) {
      const url = new URL(
        `https://io.adafruit.com/api/v2/${USER}/feeds/${feedKey}/data`
      );
      url.searchParams.set('limit', limit);
      Object.entries(params).forEach(([k, v]) => v && url.searchParams.set(k, v));
      const res = await fetch(url.toString());
      if (!res.ok) return [];
      const payload = await res.json();
      return Array.isArray(payload)
        ? payload
        : Array.isArray(payload.data)
          ? payload.data
          : [];
    }

    // FULL FEED KEYS
    function getFeeds(device) {
      return {
        gps: `${device}.gps`,
        signal: `${device}.signal`,
        volt: `${device}.volt`,
        speed: `${device}.speed`,
        nr1: `${device}.nr1`,
        nr2: `${device}.nr2`,
        nr3: `${device}.nr3`
      };
    }

    // CHART COLORS & SENSORS
    const fallbackCols = ['#44b6f7', '#7cd992', '#e7c46c'];
    const SENSORS = [
      { id: 'nr1',    label: 'NR1 °F',       col: getCSS('--g1', fallbackCols[0]), chart: null },
      { id: 'nr2',    label: 'NR2 °F',       col: getCSS('--g2', fallbackCols[1]), chart: null },
      { id: 'nr3',    label: 'NR3 °F',       col: getCSS('--g3', fallbackCols[2]), chart: null },
      { id: 'signal', label: 'RSSI (dBm)',   col: getCSS('--g4', '#999'),           chart: null },
      { id: 'volt',   label: 'Volt (mV)',    col: getCSS('--g5', '#666'),           chart: null },
      { id: 'speed',  label: 'Speed (km/h)', col: getCSS('--g6', '#333'),           chart: null }
    ];

    // INITIALIZATION
    let map, marker, polyline, trailArr = [];
    document.addEventListener('DOMContentLoaded', () => {
      initCharts();
      initMap();
      updateCharts();
      poll();
      document.getElementById('deviceSelect').addEventListener('change', e => {
        DEVICE = e.target.value;
        Object.keys(lastTs).forEach(k => lastTs[k] = null);
        trailArr = [];
        initCharts();
        updateCharts();
      });
      document.getElementById('dlBtn').addEventListener('click', async () => {
        const start = document.getElementById('start').value;
        const end = document.getElementById('end').value;
        if (!start || !end) {
          return document.getElementById('expStatus').textContent = 'Please select both start and end dates.';
        }
        document.getElementById('expStatus').textContent = 'Fetching…';
        const params = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
        const data = await Promise.all(
          Object.entries(getFeeds(DEVICE)).map(async ([key, feedKey]) => {
            const rows = await fetchFeed(feedKey, 1000, params);
            return rows.map(r => ({ feed: key, ts: r.created_at, value: r.value }));
          })
        );
        const flat = data.flat().sort((a, b) => a.ts.localeCompare(b.ts));
        const rows = [['feed','timestamp','value'], ...flat.map(r => [r.feed, r.ts, r.value])];
        const csv = rows.map(r => r.join(',')).join('
');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${DEVICE}_${start}_${end}.csv`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        document.getElementById('expStatus').textContent = 'Download ready.';
      });
    });

    function initCharts() {
      const ctr = document.getElementById('charts');
      ctr.innerHTML = '';
      SENSORS.forEach(s => {
        const card = document.createElement('div');
        card.className = 'chart-box';
        card.innerHTML = `
          <h2 class="text-sm font-semibold mb-2">${s.label}</h2>
          <canvas></canvas>
        `;
        ctr.appendChild(card);
        const ctx = card.querySelector('canvas').getContext('2d');
        s.chart = new Chart(ctx, {
          type: 'line',
          data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, tension: 0.25 }] },
          options: { animation: false, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxRotation: 0 } }, y: { grace: '5%' } } }
        });
      });
    }

    function initMap() {
      map = L.map('map').setView([0, 0], 2);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; CARTO' }).addTo(map);
      marker = L.marker([0, 0]).addTo(map);
      polyline = L.polyline([], { weight: 3 }).addTo(map);
    }

    async function updateCharts() {
      const feeds = getFeeds(DEVICE);
      await Promise.all(SENSORS.map(async s => {
        const rows = await fetchFeed(feeds[s.id], HIST);
        if (!rows.length) return;
        rows.reverse();
        s.chart.data.labels = rows.map(r => isoHHMM(r.created_at));
        s.chart.data.datasets[0].data = rows.map(r => {
          let n = parseFloat(r.value);
          if (s.id === 'nr3' && !isNaN(n)) {
            n = (n * 9/5) + 32;
          }
          return isNaN(n) ? null : +n.toFixed(1);
        });
        s.chart.update();
      }));
    }

    async function poll() {
      const feeds = getFeeds(DEVICE);
      const [gpsA, sigA, voltA, spdA, n1A, n2A, n3A] = await Promise.all([
        fetchFeed(feeds.gps), fetchFeed(feeds.signal), fetchFeed(feeds.volt),
        fetchFeed(feeds.speed), fetchFeed(feeds.nr1), fetchFeed(feeds.nr2), fetchFeed(feeds.nr3)
      ]);
      let g = { fix: false, lat: null, lon: null, alt: null, sats: null };
      try { if (gpsA[0]?.value) g = JSON.parse(gpsA[0].value); } catch {}
      const pick = arr => { const v = arr[0]?.value, n = parseFloat(v); return (v != null && !isNaN(n)) ? n : null; };
      const live = { ts: gpsA[0]?.created_at, fix: !!g.fix, lat: g.lat, lon: g.lon, alt: g.alt, sats: g.sats, signal: pick(sigA), volt: pick(voltA), speed: pick(spdA), nr1: pick(n1A), nr2: pick(n2A), nr3: pick(n3A) != null ? +((pick(n3A) * 9/5) + 32).toFixed(1) : null };
      drawLive(live);
      [['nr1', live.nr1], ['nr2', live.nr2], ['nr3', live.nr3], ['signal', live.signal], ['volt', live.volt], ['speed', live.speed]].forEach(([id, val]) => {
        if (val == null) return;
        if (live.ts !== lastTs[id]) {
          const s = SENSORS.find(x => x.id === id);
          s.chart.data.labels.push(isoHHMM(live.ts));
          s.chart.data.datasets[0].data.push(val);
          lastTs[id] = live.ts;
          if (s.chart.data.labels.length > HIST) { s.chart.data.labels.shift(); s.chart.data.datasets[0].data.shift(); }
          s.chart.update();
        }
      });
      setTimeout(poll, POLL_MS);
    }

    function drawLive({ ts, fix, lat, lon, alt, sats, signal, volt, speed, nr1, nr2, nr3 }) {
      document.getElementById('latest').innerHTML = [
        ['Local Time', new Date(ts).toLocaleString()], ['Lat', fmt(lat, 6)], ['Lon', fmt(lon, 6)], ['Alt (m)', fmt(alt, 1)], ['Sats', fmt(sats, 0)], ['Speed (km/h)', fmt(speed, 1)], ['RSSI (dBm)', fmt(signal, 0)], ['Volt (mV)', fmt(volt, 2)], ['NR1 °F', fmt(nr1, 1)], ['NR2 °F', fmt(nr2, 1)], ['NR3 °F', fmt(nr3, 1)]
      ].map(([k, v]) => `<tr><th class="pr-2 text-left">${k}</th><td>${v}</td></tr>`).join('');
    }
  </script>
</body>
</html>
