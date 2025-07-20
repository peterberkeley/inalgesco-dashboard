<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>SkyCafé Sensor Dashboard</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.3/dist/leaflet.css"/>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.3/dist/leaflet.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
      --color-primary: #2563eb;
      --color-secondary: #0ea5e9;
      --color-accent: #10b981;
      --color-text: #334155;
      --color-card: #f1f5f9;
    }
    body { background: #f7fafc; font-family: 'Inter', sans-serif; }
    .container { max-width: 1000px; margin: 2rem auto; }
    .header { font-size: 1.7rem; font-weight: bold; color: var(--color-primary);}
    .chart-box { background: #fff; border-radius: 1.2rem; box-shadow: 0 2px 16px rgba(0,0,0,0.08); padding: 1.2rem; margin: 1rem 0; min-width:250px; width:100%; height:220px; }
    .chart-box h2 { font-size:1.12rem; color:var(--color-primary); font-weight:600; margin-bottom:8px;}
    #charts { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    #map { width:100%; height: 240px; border-radius:1.2rem; margin:18px 0 10px 0; }
    #deviceSelect { margin-bottom: 1.2rem; padding: 0.35rem 1.2rem; border-radius: 8px; background: #e5e7eb; font-weight: 600;}
    th { font-weight: 500; color:#334155;}
    td { color:#334155;}
    #latest th { width:170px;}
    .greyed { color:#aaa; background:#f4f4f4 !important;}
  </style>
</head>
<body>
  <div class="container bg-white shadow-lg rounded-2xl p-7 mt-8">
    <div class="flex flex-row justify-between items-center mb-6">
      <span class="header">SkyCafé Sensor Dashboard</span>
      <select id="deviceSelect"></select>
    </div>
    <div class="flex flex-col md:flex-row gap-8">
      <div class="flex-1">
        <table id="latest" class="mb-4 w-full"></table>
        <div id="charts"></div>
      </div>
      <div class="flex-1 md:max-w-sm">
        <div id="map"></div>
      </div>
    </div>
    <div class="mt-4 text-xs text-gray-500">Questions? <a href="mailto:support@sky-cafe.com" class="underline">support@sky-cafe.com</a></div>
  </div>
  <script>
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
  const UBIDOTS_TOKEN = "BBUS-Ghwc4x45HcRvzw1eOVF1DfBQBnAP7L";
  const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v1.6";
  const CONFIG_DEVICE = "config";
  const CONFIG_VARIABLE = "sensor_map";
  const CONFIG_URL = `${UBIDOTS_BASE}/devices/${CONFIG_DEVICE}/${CONFIG_VARIABLE}/values?page_size=1&token=${UBIDOTS_TOKEN}`;

  const POLL_MS = 10000, HIST = 50, TRAIL = 50;
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = 'skycafe-12';

  let SENSOR_MAP = {};
  const SENSOR_COLORS = [COLORS.primary, COLORS.secondary, COLORS.accent, "#8b5cf6", "#10b981"];
  let DALLAS_LIST = [];

  // --- Fetch mapping/calibration config from Ubidots context
  async function fetchSensorMapConfig() {
    try {
      const res = await fetch(CONFIG_URL);
      if (!res.ok) throw new Error("Failed to fetch sensor map config");
      const js = await res.json();
      return (js.results && js.results[0] && js.results[0].context) ? js.results[0].context : {};
    } catch (e) {
      return {};
    }
  }

  // --- Fetch Dallas addresses (16-char hex, only if polled in last 3 min)
  async function fetchDallasAddresses(dev) {
    try {
      const url = `${UBIDOTS_BASE}/variables/?device=${dev}&token=${UBIDOTS_TOKEN}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const js = await res.json();
      const now = Date.now();
      return js.results
        .filter(v => /^[0-9a-fA-F]{16}$/.test(v.label))
        .filter(v => {
          let t = (v.last_value && v.last_value.timestamp) || 0;
          return (now - t) < 3 * 60 * 1000;
        })
        .map(v => v.label)
        .sort();
    } catch {
      return [];
    }
  }

  function buildSensorSlots() {
    const mapped = SENSOR_MAP[DEVICE] || {};
    const allAddr = DALLAS_LIST.slice(0, 5);
    while (allAddr.length < 5) allAddr.push(null);
    return allAddr.map((addr, idx) => {
      if (!addr) return {
        id: `empty${idx}`,
        label: '',
        col: SENSOR_COLORS[idx],
        chart: null,
        address: null,
        mapped: null,
        calibration: 0,
      };
      let label = mapped[addr]?.label?.trim() || addr;
      let offset = typeof mapped[addr]?.offset === 'number' ? mapped[addr].offset : 0;
      return {
        id: addr,
        label,
        col: SENSOR_COLORS[idx],
        chart: null,
        address: addr,
        mapped: mapped[addr],
        calibration: offset,
      };
    });
  }

  // --- Utility for value formatting
  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);

  function initCharts(SENSORS) {
    const ctr = document.getElementById('charts');
    ctr.innerHTML = '';
    SENSORS.forEach(s => {
      s.chart = null;
      const card = document.createElement('div'); card.className = 'chart-box';
      card.innerHTML = `<h2>${s.label || ''}</h2><canvas></canvas>`;
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

  async function fetchUbidotsVar(dev, variable, limit = 1) {
    let url = `${UBIDOTS_BASE}/devices/${dev}/${variable}/values?page_size=${limit}`;
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

  // --- LIVENESS CHECK: Require TWO readings within 1 minute for any sensor address
  async function isTruckLive(dev) {
    try {
      let url = `${UBIDOTS_BASE}/variables/?device=${dev}&token=${UBIDOTS_TOKEN}`;
      let res = await fetch(url);
      if (!res.ok) return false;
      let js = await res.json();
      let now = Date.now();
      // Only consider sensor addresses (Dallas): 16 hex chars, recently active
      let sensors = js.results.filter(v =>
        /^[0-9a-fA-F]{16}$/.test(v.label) &&
        v.last_value && v.last_value.timestamp &&
        now - v.last_value.timestamp < 3 * 60 * 1000
      );
      // For each sensor, fetch last 2 records and test timing
      for (let v of sensors) {
        let valsUrl = `${UBIDOTS_BASE}/variables/${v.id}/values?page_size=2&token=${UBIDOTS_TOKEN}`;
        let valsRes = await fetch(valsUrl);
        if (!valsRes.ok) continue;
        let valsJs = await valsRes.json();
        let vals = valsJs.results || [];
        if (vals.length < 2) continue;
        let t0 = vals[0].timestamp, t1 = vals[1].timestamp;
        if (Math.abs(t0 - t1) < 60 * 1000 && now - t0 < 3 * 60 * 1000) {
          // Found at least one address with two records in 1 minute
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // --- Device selector and initialization ---
  document.addEventListener('DOMContentLoaded', async () => {
    SENSOR_MAP = await fetchSensorMapConfig();

    // Check which trucks are "live"
    let deviceStatus = {};
    await Promise.all(DEVICES.map(async dev => {
      deviceStatus[dev] = await isTruckLive(dev) ? 'online' : 'offline';
    }));

    const deviceSelect = document.getElementById('deviceSelect');
    deviceSelect.innerHTML = '';
    let savedDevice = localStorage.getItem('selectedDevice');
    if (!savedDevice || !DEVICES.includes(savedDevice)) {
      savedDevice = DEVICES[0];
    }
    DEVICE = savedDevice;

    DEVICES.forEach(dev => {
      const opt = document.createElement('option');
      opt.value = dev;
      opt.text = dev.replace('skycafe-','SkyCafé ');
      if (deviceStatus[dev] === 'offline') {
        opt.disabled = true;
        opt.text += ' (Offline)';
        opt.style.color = '#aaa'; opt.style.background = '#f4f4f4';
      }
      deviceSelect.appendChild(opt);
    });

    deviceSelect.value = DEVICE;
    deviceSelect.addEventListener('change', async e => {
      DEVICE = e.target.value;
      localStorage.setItem('selectedDevice', DEVICE);
      document.getElementById('latest').innerHTML = '';
      trail = []; polyline.setLatLngs([]);
      DALLAS_LIST = await fetchDallasAddresses(DEVICE);
      const SENSORS = buildSensorSlots();
      initCharts(SENSORS);
      updateCharts(SENSORS).then(() => { initMap(); poll(SENSORS); });
    });

    DALLAS_LIST = await fetchDallasAddresses(DEVICE);
    const SENSORS = buildSensorSlots();
    initCharts(SENSORS);
    updateCharts(SENSORS).then(() => { initMap(); poll(SENSORS); });
  });
  // --- Update charts for dynamic sensor addresses
  async function updateCharts(SENSORS) {
    await Promise.all(SENSORS.map(async (s, idx) => {
      if (!s.address) return;
      const rows = await fetchUbidotsVar(DEVICE, s.address, HIST);
      if (!rows.length) return;
      s.chart.data.labels = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true }));
      s.chart.data.datasets[0].data = rows.map(r => {
        let val = parseFloat(r.value);
        if (typeof s.calibration === 'number') val += s.calibration;
        return isNaN(val) ? null : val;
      });
      s.chart.update();
    }));
  }

  function drawLive(data, SENSORS) {
    let { ts, iccid, lat, lon, speed, signal, volt, addresses, readings } = data;
    if (!ts) ts = Date.now();
    const sensorRows = SENSORS.map((s, idx) =>
      [s.label, s.address && readings[s.address] != null ? fmt(readings[s.address] + (s.calibration || 0),1) : '']
    );
    const rows = [
      ['Local Time', ts ? new Date(ts).toLocaleString() : '–'],
      ['ICCID', iccid || '–'],
      ['Lat', fmt(lat,6)], ['Lon', fmt(lon,6)],
      ['Speed (km/h)', fmt(speed,1)], ['RSSI (dBm)', fmt(signal,0)],
      ['Volt (mV)', fmt(volt,2)]
    ].concat(sensorRows);
    document.getElementById('latest').innerHTML = rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if (isFinite(lat) && isFinite(lon)) {
      marker.setLatLng([lat,lon]);
      trail.push([lat,lon]); if (trail.length > TRAIL) trail.shift();
      polyline.setLatLngs(trail);
      map.setView([lat,lon], Math.max(map.getZoom(),13));
    }
  }

  async function poll(SENSORS) {
    const [gpsArr, iccArr] = await Promise.all([
      fetchUbidotsVar(DEVICE,'gps'),
      fetchUbidotsVar(DEVICE,'iccid')
    ]);
    let ts=null, lat=null, lon=null, speed=null;
    if (gpsArr[0]?.created_at) ts = gpsArr[0].created_at;
    if (gpsArr[0]?.context) {
      lat   = gpsArr[0].context.lat;
      lon   = gpsArr[0].context.lng;
      speed = gpsArr[0].context.speed;
    }
    if (!ts) ts = iccArr[0]?.created_at || Date.now();
    const iccidVal = iccArr[0]?.value || null;

    let readings = {};
    await Promise.all(SENSORS.filter(s=>s.address).map(async s => {
      const vals = await fetchUbidotsVar(DEVICE, s.address, 1);
      if (vals.length && vals[0].value != null) readings[s.address] = parseFloat(vals[0].value);
    }));

    let [signalArr, voltArr, speedArr] = await Promise.all([
      fetchUbidotsVar(DEVICE,'signal',1),
      fetchUbidotsVar(DEVICE,'volt',1),
      fetchUbidotsVar(DEVICE,'speed',1),
    ]);
    let signalVal = signalArr[0]?.value || null;
    let voltVal   = voltArr[0]?.value || null;
    let speedVal  = speedArr[0]?.value || null;

    drawLive(
      {
        ts, iccid: iccidVal, lat, lon, speed: speedVal,
        signal: signalVal, volt: voltVal, addresses: SENSORS.map(s=>s.address), readings
      },
      SENSORS
    );
    setTimeout(()=>poll(SENSORS), POLL_MS);
  }

})(); // End IIFE
  </script>
</body>
</html>
