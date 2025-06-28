// dashboard.js — supports skycafe-1 through skycafe-24
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

  // [1a] STATIC DEVICE LIST (skycafe-1 … skycafe-24)
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = DEVICES[0];

  // [2] SENSORS & ICCID
  const SENSORS = [
    { id: 'nr1',    label: 'NR1 °F',       col: COLORS.primary,   chart: null },
    { id: 'nr2',    label: 'NR2 °F',       col: COLORS.secondary, chart: null },
    { id: 'nr3',    label: 'NR3 °F',       col: COLORS.accent,    chart: null },
    { id: 'signal', label: 'RSSI (dBm)',   col: COLORS.text,      chart: null },
    { id: 'volt',   label: 'Volt (mV)',    col: '#FF0000',        chart: null },
    { id: 'speed',  label: 'Speed (km/h)', col: COLORS.secondary, chart: null }
  ];

  // [3] CSS HELPER
  function getCSS(varName, fallback = '') {
    return (getComputedStyle(document.documentElement)
      .getPropertyValue(varName) || '').trim() || fallback;
  }

  // [4] FEED KEYS
  function getFeeds(device) {
    const feeds = { gps: `${device}.gps`, iccid: `${device}.iccid` };
    SENSORS.forEach(s => feeds[s.id] = `${device}.${s.id}`);
    return feeds;
  }

  // [5] FETCH UTILITY
  async function fetchFeed(feedKey, limit = 1) {
    const url = new URL(`https://io.adafruit.com/api/v2/${USER}/feeds/${feedKey}/data`);
    url.searchParams.set('limit', limit);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Fetch failed [${feedKey}]:`, res.status);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : []);
  }

  // [6] FORMAT HELPERS
  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);
  const formatTime12h = ts => ts
    ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
    : '';

  // [7] INIT CHARTS
  function initCharts() {
    const ctr = document.getElementById('charts');
    ctr.innerHTML = '';
    SENSORS.forEach(s => {
      s.chart = null;
      const card = document.createElement('div');
      card.className = 'chart-box';
      card.innerHTML = `<h2>${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx = card.querySelector('canvas').getContext('2d');
      s.chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            data: [],
            borderColor: s.col,
            borderWidth: 2,
            tension: 0.25
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } }
        }
      });
    });
  }

  // [8] INIT MAP
  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
    marker = L.marker([0, 0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
  }

  // [9] UPDATE HISTORICAL DATA
  async function updateCharts() {
    const feeds = getFeeds(DEVICE);
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchFeed(feeds[s.id], HIST);
      if (!rows.length) return;
      const labels = rows.map(r => formatTime12h(r.created_at));
      const values = rows.map(r => parseFloat(r.value) || null);
      s.chart.data.labels = labels;
      s.chart.data.datasets[0].data = values;
      s.chart.update();
    }));
  }

  // [10] DRAW LIVE & ICCID & APPEND
  function drawLive(data) {
    const { ts, lat, lon, signal, volt, speed, nr1, nr2, nr3, iccid } = data;
    const rows = [
      ['Local Time', new Date(ts).toLocaleString()],
      ['ICCID', iccid || '–'],
      ['Lat', fmt(lat, 6)], ['Lon', fmt(lon, 6)],
      ['Speed (km/h)', fmt(speed, 1)], ['RSSI (dBm)', fmt(signal, 0)],
      ['Volt (mV)', fmt(volt, 2)], ['NR1 °F', fmt(nr1, 1)],
      ['NR2 °F', fmt(nr2, 1)], ['NR3 °F', fmt(nr3, 1)]
    ];
    document.getElementById('latest').innerHTML =
      rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if (isFinite(lat) && isFinite(lon)) {
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
    const live = {
      ts:    gpsA[0]?.created_at,
      lat, lon,
      signal: parseFloat(sigA[0]?.value) || null,
      volt:   parseFloat(voltA[0]?.value) || null,
      speed:  parseFloat(spA[0]?.value) || null,
      nr1:    parseFloat(n1A[0]?.value) || null,
      nr2:    parseFloat(n2A[0]?.value) || null,
      nr3:    parseFloat(n3A[0]?.value) || null,
      iccid:  icA[0]?.value || null
    };
    drawLive(live);
    const tsLabel = formatTime12h(live.ts);
    SENSORS.forEach(s => {
      const val = live[s.id];
      if (val == null) return;
      s.chart.data.labels.push(tsLabel);
      s.chart.data.datasets[0].data.push(val);
      if (s.chart.data.labels.length > HIST) {
        s.chart.data.labels.shift();
        s.chart.data.datasets[0].data.shift();
      }
      s.chart.update();
    });
    setTimeout(poll, POLL_MS);
  }

// [12] CSV EXPORT
document.getElementById('dlBtn').addEventListener('click', async ev => {
  ev.preventDefault();

  let startInput = document.getElementById('start').value;
  let endInput   = document.getElementById('end').value;
  if (!startInput || !endInput) {
    return alert('Please set both a start and end date/time.');
  }

  // Convert to ISO for the API
  const startISO = new Date(startInput).toISOString();
  const endISO   = new Date(endInput).toISOString();

  // Build list of all feed IDs
  const feeds  = getFeeds(DEVICE);
  const allIds = ['gps','iccid', ...SENSORS.map(s => s.id)];

  // Fetch each feed and assemble into a timestamp-indexed map
  const dataMap = {};  // { timestamp: { feedId: value, … }, … }
  for (const id of allIds) {
    const url = new URL(`https://io.adafruit.com/api/v2/${USER}/feeds/${feeds[id]}/data`);
    url.searchParams.set('start_time', startISO);
    url.searchParams.set('end_time',   endISO);
    url.searchParams.set('limit',      1000);

    try {
      const res  = await fetch(url);
      const body = await res.json();
      const list = Array.isArray(body) ? body : (Array.isArray(body.data) ? body.data : []);
      list.forEach(d => {
        const ts = d.created_at;
        if (!dataMap[ts]) dataMap[ts] = {};
        dataMap[ts][id] = d.value;
      });
    } catch (err) {
      console.error(`Failed to fetch ${id}:`, err);
    }
  }

  // Build rows: header + one row per timestamp
  const rows       = [];
  const timestamps = Object.keys(dataMap).sort();
  const header     = ['Date','Time', ...allIds];
  rows.push(header);

  timestamps.forEach(ts => {
    const dt   = new Date(ts);
    const date = dt.toLocaleDateString();
    const time = dt.toLocaleTimeString();
    const row  = [
      date,
      time,
      ...allIds.map(id => dataMap[ts][id] ?? '')
    ];
    rows.push(row);
  });

  // Convert to semicolon-delimited CSV string, escaping inner quotes
  const sepLine = 'sep=;\n';
  const body = rows.map(row =>
    row.map(cell => {
      const s = String(cell).replace(/"/g, '""');
      return `"${s}"`;
    }).join(';')
  ).join('\n');
  const csv = sepLine + body;

  // Trigger download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href     = URL.createObjectURL(blob);
  link.download = `${DEVICE}-${startInput}-${endInput}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

  // [13] BOOTSTRAP & DEVICE CHANGE
  document.addEventListener('DOMContentLoaded', () => {
    const deviceSelect = document.getElementById('deviceSelect');
    DEVICES.forEach(dev => {
      const opt = document.createElement('option');
      opt.value = dev;
      opt.text  = dev.replace('skycafe-','SkyCafé ');
      deviceSelect.appendChild(opt);
    });
    deviceSelect.addEventListener('change', e => {
      DEVICE = e.target.value;
      showSpinner();
      document.getElementById('latest').innerHTML = '';
      trail = [];
      if (polyline) polyline.setLatLngs([]);
      initCharts();
      updateCharts().then(() => { hideSpinner(); });
    });
    showSpinner();
    initCharts();
    updateCharts().then(() => {
      initMap(); hideSpinner(); poll();
    });
  });
})();
