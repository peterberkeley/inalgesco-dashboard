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

  // --- Device selector and initialization ---
  document.addEventListener('DOMContentLoaded', async () => {
    SENSOR_MAP = await fetchSensorMapConfig();

    // [LIVENESS: any variable updated in last 60s = live]
    let deviceStatus = {};
    const now = Date.now();

    await Promise.all(DEVICES.map(async dev => {
      try {
        const url = `${UBIDOTS_BASE}/variables/?device=${dev}&token=${UBIDOTS_TOKEN}`;
        const res = await fetch(url);
        if (!res.ok) { deviceStatus[dev] = 'offline'; return; }
        const js = await res.json();
        // If ANY variable was updated in the last 60 seconds, consider live
        let isLive = (js.results || []).some(v => v.last_value && v.last_value.timestamp && (now - v.last_value.timestamp < 60 * 1000));
        deviceStatus[dev] = isLive ? 'online' : 'offline';
      } catch {
        deviceStatus[dev] = 'offline';
      }
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
