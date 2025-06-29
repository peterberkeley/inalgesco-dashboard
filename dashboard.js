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
  const UBIDOTS_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
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

  // [4] FEED KEYS (for compatibility, not actually used in API)
  function getFeeds(device) {
    const feeds = { gps: `gps`, iccid: `iccid` };
    SENSORS.forEach(s => feeds[s.id] = s.id);
    return feeds;
  }

  // [5] FETCH UTILITY — Ubidots
  async function fetchUbidotsVar(device, variable, limit = 1, start = null, end = null) {
    let url = `https://industrial.api.ubidots.com/api/v1.6/devices/${device}/${variable}/values?page_size=${limit}`;
    if (start) url += `&start=${encodeURIComponent(start)}`;
    if (end)   url += `&end=${encodeURIComponent(end)}`;
    const res = await fetch(url, {
      headers: { "X-Auth-Token": UBIDOTS_TOKEN }
    });
    if (!res.ok) {
      console.error(`Failed to fetch ${device}/${variable}:`, res.status);
      return [];
    }
    const json = await res.json();
    return json.results || [];
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
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchUbidotsVar(DEVICE, s.id, HIST);
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
    // Fetch latest value for each variable from Ubidots
    const [gpsA, sigA, voltA, spA, n1A, n2A, n3A, icA] = await Promise.all([
      fetchUbidotsVar(DEVICE, 'gps'),
      fetchUbidotsVar(DEVICE, 'signal'),
      fetchUbidotsVar(DEVICE, 'volt'),
      fetchUbidotsVar(DEVICE, 'speed'),
      fetchUbidotsVar(DEVICE, 'nr1'),
      fetchUbidotsVar(DEVICE, 'nr2'),
      fetchUbidotsVar(DEVICE, 'nr3'),
      fetchUbidotsVar(DEVICE, 'iccid')
    ]);
    let lat = null, lon = null;
try {
  if (gpsA[0] && gpsA[0].context) {
    lat = parseFloat(gpsA[0].context.lat);
    lon = parseFloat(gpsA[0].context.lng);
  }
} catch (e) {
  console.error('Error parsing GPS context:', e, gpsA[0]);
}

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

    // Build list of all variable IDs
    const allIds = ['gps','iccid', ...SENSORS.map(s => s.id)];
    // Fetch each variable from Ubidots
    const dataMap = {};  // { timestamp: { varId: value, … }, … }
    for (const id of allIds) {
      try {
        const data = await fetchUbidotsVar(DEVICE, id, 1000, startISO, endISO);
        data.forEach(d => {
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
