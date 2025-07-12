(() => {
  // [0] THEME COLORS
  const COLORS = {
    primary: getCSS('--color-primary'),
    secondary: getCSS('--color-secondary'),
    accent: getCSS('--color-accent'),
    text: getCSS('--color-text'),
    card: getCSS('--color-card')
  };
  function getCSS(varName, fallback = '') {
    return (getComputedStyle(document.documentElement).getPropertyValue(varName) || '').trim() || fallback;
  }

  // [1] CONFIGURATION
  // --- Use single account token for all devices ---
  const UBIDOTS_TOKEN = "BBUS-Ghwc4x45HcRvzw1eOVF1DfBQBnAP7L"; // YOUR ORG TOKEN
  const CONFIG_DEVICE = "config";
  const CONFIG_VARIABLE = "sensor_map";
  const CONFIG_URL = `https://industrial.api.ubidots.com/api/v1.6/devices/${CONFIG_DEVICE}/${CONFIG_VARIABLE}/values?page_size=1&token=${UBIDOTS_TOKEN}`;

  const POLL_MS = 10000, HIST = 50, TRAIL = 50;
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = 'skycafe-1';

  // SENSOR_MAP will be populated from Ubidots context
  let SENSOR_MAP = {};

  const SENSORS = [
    { id: 'nr1', label: 'NR1 °F', col: COLORS.primary, chart: null },
    { id: 'nr2', label: 'NR2 °F', col: COLORS.secondary, chart: null },
    { id: 'nr3', label: 'NR3 °F', col: COLORS.accent, chart: null },
    { id: 'signal', label: 'RSSI (dBm)', col: COLORS.text, chart: null },
    { id: 'volt', label: 'Volt (mV)', col: '#FF0000', chart: null },
    { id: 'speed', label: 'Speed (km/h)', col: COLORS.secondary, chart: null }
  ];

  // --- Fetch mapping/calibration config from Ubidots context
  async function fetchSensorMapConfig() {
    try {
      const res = await fetch(CONFIG_URL);
      if (!res.ok) throw new Error("Failed to fetch sensor map config");
      const js = await res.json();
      return (js.results && js.results[0] && js.results[0].context) ? js.results[0].context : {};
    } catch (e) {
      console.error("Error fetching sensor map config:", e);
      return {};
    }
  }

  // Get mapped label and offset for sensor address
  function getSensorLabel(truck, addr, fallback) {
    return (SENSOR_MAP[truck] && SENSOR_MAP[truck][addr] && SENSOR_MAP[truck][addr].label)
      ? SENSOR_MAP[truck][addr].label
      : (fallback || addr);
  }
  function getSensorOffset(truck, addr) {
    return (SENSOR_MAP[truck] && SENSOR_MAP[truck][addr] && typeof SENSOR_MAP[truck][addr].offset === "number")
      ? SENSOR_MAP[truck][addr].offset
      : 0;
  }

  async function fetchUbidotsVar(dev, variable, limit = 1, start = null, end = null) {
    let url = `https://industrial.api.ubidots.com/api/v1.6/devices/${dev}/${variable}/values?page_size=${limit}`;
    if (start) url += `&start=${encodeURIComponent(start)}`;
    if (end)   url += `&end=${encodeURIComponent(end)}`;
    const token = UBIDOTS_TOKEN;
    if (!token) return [];
    try {
      const res = await fetch(url, { headers: { 'X-Auth-Token': token } });
      if (!res.ok) return [];
      const js = await res.json();
      return js.results || [];
    } catch {
      return [];
    }
  }

  // -------- PATCHED: fetch all records in date range (paging) --------
  async function fetchAllUbidotsVar(dev, variable, start = null, end = null) {
    const token = UBIDOTS_TOKEN;
    if (!token) return [];
    let url = `https://industrial.api.ubidots.com/api/v1.6/devices/${dev}/${variable}/values?page_size=1000`;
    if (start) url += `&start=${encodeURIComponent(start)}`;
    if (end)   url += `&end=${encodeURIComponent(end)}`;
    let results = [];
    while (url) {
      const res = await fetch(url, { headers: { 'X-Auth-Token': token } });
      if (!res.ok) break;
      const js = await res.json();
      results = results.concat(js.results || []);
      url = js.next; // will be null if no more pages
    }
    return results;
  }
  // -------------------------------------------------------------------

  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);

  function initCharts() {
    const ctr = document.getElementById('charts');
    ctr.innerHTML = '';
    SENSORS.forEach(s => {
      s.chart = null;
      const card = document.createElement('div'); card.className = 'chart-box';
      card.innerHTML = `<h2>${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx = card.querySelector('canvas').getContext('2d');
      s.chart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, tension: 0.25 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      });
    });
  }

  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map('map').setView([0,0],2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
    marker = L.marker([0,0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
  }

  async function updateCharts() {
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchUbidotsVar(DEVICE, s.id, HIST);
      if (!rows.length) return;
      s.chart.data.labels    = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true }));
      s.chart.data.datasets[0].data = rows.map(r => {
        let val = parseFloat(r.value) || null;
        // --- PATCH: Apply calibration if mapping exists
        if (s.id.startsWith('nr')) {
          // Try to find mapped address for this sensor id, else no offset
          const addr = Object.keys((SENSOR_MAP[DEVICE]||{})).find(a => getSensorLabel(DEVICE,a).toLowerCase()===s.label.toLowerCase());
          if (addr) val += getSensorOffset(DEVICE, addr);
        }
        return val;
      });
      s.chart.update();
    }));
  }

  // === PATCHED: drawLive now always shows a Local Time ===
  function drawLive(data) {
    let { ts, iccid, lat, lon, speed, signal, volt, nr1, nr2, nr3 } = data;
    if (!ts) ts = Date.now(); // fallback to now if missing
    // Try to get mapped labels
    const rows = [
      ['Local Time', ts ? new Date(ts).toLocaleString() : '–'],
      ['ICCID', iccid || '–'],
      ['Lat', fmt(lat,6)], ['Lon', fmt(lon,6)],
      ['Speed (km/h)', fmt(speed,1)], ['RSSI (dBm)', fmt(signal,0)],
      ['Volt (mV)', fmt(volt,2)],
      [getSensorLabel(DEVICE, 'nr1', 'NR1 °F'), fmt(nr1,1)],
      [getSensorLabel(DEVICE, 'nr2', 'NR2 °F'), fmt(nr2,1)],
      [getSensorLabel(DEVICE, 'nr3', 'NR3 °F'), fmt(nr3,1)]
    ];
    document.getElementById('latest').innerHTML = rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if (isFinite(lat) && isFinite(lon)) {
      marker.setLatLng([lat,lon]);
      trail.push([lat,lon]); if (trail.length > TRAIL) trail.shift();
      polyline.setLatLngs(trail);
      map.setView([lat,lon], Math.max(map.getZoom(),13));
    }
  }

  // === PATCHED: poll sets ts from any available variable ===
  async function poll() {
    const [gpsArr, iccArr, ...sensorArrs] = await Promise.all([
      fetchUbidotsVar(DEVICE,'gps'),
      fetchUbidotsVar(DEVICE,'iccid'),
      ...SENSORS.map(s => fetchUbidotsVar(DEVICE,s.id))
    ]);
    let ts=null, lat=null, lon=null, speed=null;
    // Try GPS timestamp first
    if (gpsArr[0]?.created_at) ts = gpsArr[0].created_at;
    if (gpsArr[0]?.context) {
      lat   = gpsArr[0].context.lat;
      lon   = gpsArr[0].context.lng;
      speed = gpsArr[0].context.speed;
    }
    // Fallback to iccid or any sensor timestamp if GPS is missing
    if (!ts) ts = iccArr[0]?.created_at || sensorArrs.find(a => a[0]?.created_at)?.[0]?.created_at || Date.now();
    const iccidVal = iccArr[0]?.value || null;
    const signalVal = sensorArrs[0][0]?.value || null;
    const voltVal   = sensorArrs[1][0]?.value || null;
    // Apply calibration if mapping exists
    let nr1Val = sensorArrs[2][0]?.value || null;
    let nr2Val = sensorArrs[3][0]?.value || null;
    let nr3Val = sensorArrs[4][0]?.value || null;
    // Get offset if mapped
    if (SENSOR_MAP[DEVICE]) {
      for (let addr in SENSOR_MAP[DEVICE]) {
        const info = SENSOR_MAP[DEVICE][addr];
        if (info.label && info.label.toLowerCase() === 'nr1 °f' && typeof info.offset === "number" && nr1Val != null) nr1Val = (+nr1Val) + info.offset;
        if (info.label && info.label.toLowerCase() === 'nr2 °f' && typeof info.offset === "number" && nr2Val != null) nr2Val = (+nr2Val) + info.offset;
        if (info.label && info.label.toLowerCase() === 'nr3 °f' && typeof info.offset === "number" && nr3Val != null) nr3Val = (+nr3Val) + info.offset;
      }
    }
    drawLive({ ts, iccid: iccidVal, lat, lon, speed, signal: signalVal, volt: voltVal, nr1: nr1Val, nr2: nr2Val, nr3: nr3Val });
    setTimeout(poll, POLL_MS);
  }

  // ...rest of your dashboard code below (maintenance, handlers, CSV, device select, etc.)...

  // --- Device status check and selector with memory + gray-out ---
  document.addEventListener('DOMContentLoaded', async () => {
    // 1. Fetch mapping config first!
    SENSOR_MAP = await fetchSensorMapConfig();

    // (Continue with your existing code here, unchanged)
    // ... (device selector, CSV export, maintenance, handlers, etc.) ...
    // Everything works as before, but now uses live mapping!
    // (Paste the rest of your document.addEventListener code block as in your current file)
  });
})();
