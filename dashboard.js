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
  const UBIDOTS_TOKEN = "BBUS-Ghwc4x45HcRvzw1eOVF1DfBQBnAP7L";
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
      s.chart.data.datasets[0].data = rows.map(r => parseFloat(r.value) || null);
      s.chart.update();
    }));
  }

  // === PATCHED: drawLive now always shows a Local Time ===
  function drawLive(data) {
    let { ts, iccid, lat, lon, speed, signal, volt, nr1, nr2, nr3 } = data;
    if (!ts) ts = Date.now(); // fallback to now if missing
    const rows = [
      ['Local Time', ts ? new Date(ts).toLocaleString() : '–'],
      ['ICCID', iccid || '–'],
      ['Lat', fmt(lat,6)], ['Lon', fmt(lon,6)],
      ['Speed (km/h)', fmt(speed,1)], ['RSSI (dBm)', fmt(signal,0)],
      ['Volt (mV)', fmt(volt,2)], ['NR1 °F', fmt(nr1,1)], ['NR2 °F', fmt(nr2,1)], ['NR3 °F', fmt(nr3,1)]
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
    const nr1Val    = sensorArrs[2][0]?.value || null;
    const nr2Val    = sensorArrs[3][0]?.value || null;
    const nr3Val    = sensorArrs[4][0]?.value || null;
    drawLive({ ts, iccid: iccidVal, lat, lon, speed, signal: signalVal, volt: voltVal, nr1: nr1Val, nr2: nr2Val, nr3: nr3Val });
    setTimeout(poll, POLL_MS);
  }

  // === Maintenance Countdown Logic ===
  function updateMaintenanceStatus() {
    const filterDays = 30;
    const serviceDays = 180;
    const now = new Date();

    const filterKey = `${DEVICE}-filter`;
    const serviceKey = `${DEVICE}-service`;

    let lastFilter = localStorage.getItem(filterKey);
    let lastService = localStorage.getItem(serviceKey);

    lastFilter = lastFilter ? new Date(lastFilter) : new Date(now.getTime() - 365 * 86400000);
    lastService = lastService ? new Date(lastService) : new Date(now.getTime() - 365 * 86400000);

    const filterUsed = Math.floor((now - lastFilter) / 86400000);
    const serviceUsed = Math.floor((now - lastService) / 86400000);
    const filterLeft = filterDays - filterUsed;
    const serviceLeft = serviceDays - serviceUsed;

    const filterStatus = document.getElementById('filterStatus');
    const serviceStatus = document.getElementById('serviceStatus');
    const resetFilterBtn = document.getElementById('resetFilterBtn');
    const resetServiceBtn = document.getElementById('resetServiceBtn');

    if (filterStatus) {
      if (filterLeft < 0) {
        filterStatus.innerHTML = `<span style="color:red;font-weight:bold;">Filter change overdue by ${-filterLeft} day(s)!</span>`;
        resetFilterBtn.style.display = '';
      } else {
        filterStatus.innerHTML = `Filter: <b>${filterLeft} day(s) left</b> until next change.`;
        resetFilterBtn.style.display = filterLeft <= 3 ? '' : 'none';
      }
    }
    if (serviceStatus) {
      if (serviceLeft < 0) {
        serviceStatus.innerHTML = `<span style="color:red;font-weight:bold;">Service overdue by ${-serviceLeft} day(s)!</span>`;
        resetServiceBtn.style.display = '';
      } else {
        serviceStatus.innerHTML = `Service: <b>${serviceLeft} day(s) left</b> until next service.`;
        resetServiceBtn.style.display = serviceLeft <= 7 ? '' : 'none';
      }
    }
  }

  // --- Robust Handlers (always re-attached) ---
  function setupMaintenanceHandlers() {
    const resetFilterBtn = document.getElementById('resetFilterBtn');
    const resetServiceBtn = document.getElementById('resetServiceBtn');

    if (resetFilterBtn) {
      resetFilterBtn.onclick = () => {
        if (confirm("Mark filter change as done today?")) {
          localStorage.setItem(`${DEVICE}-filter`, new Date().toISOString());
          updateMaintenanceStatus();
          setupMaintenanceHandlers();
        }
      };
    }
    if (resetServiceBtn) {
      resetServiceBtn.onclick = () => {
        const code = prompt("Enter service reset code:");
        if (code === null) return;
        if (code.trim() === "8971") {
          localStorage.setItem(`${DEVICE}-service`, new Date().toISOString());
          updateMaintenanceStatus();
          setupMaintenanceHandlers();
          alert("Service reset successful.");
        } else {
          alert("Incorrect code. Service was not reset.");
        }
      };
    }
  }

  // --- Device status check and selector with memory + gray-out ---
  document.addEventListener('DOMContentLoaded', async () => {
    // 1. Fetch mapping config first!
    SENSOR_MAP = await fetchSensorMapConfig();

    // Utility to check device "last activity"
    async function getDeviceLastTimestamp(dev) {
      try {
        const url = `https://industrial.api.ubidots.com/api/v1.6/devices/${dev}/`;
        const res = await fetch(url, { headers: { 'X-Auth-Token': UBIDOTS_TOKEN } });
        if (!res.ok) return 0;
        const js = await res.json();
        // Use the device's 'last_activity' timestamp if available (in ms)
        return new Date(js.last_activity).getTime() || 0;
      } catch {
        return 0;
      }
    }

    // Determine offline devices (no activity in last hour)
    const now = Date.now();
    const offlineCutoff = 60 * 60 * 1000; // 1 hour
    let deviceStatus = {};
    await Promise.all(DEVICES.map(async dev => {
      let lastTs = await getDeviceLastTimestamp(dev);
      deviceStatus[dev] = (now - lastTs < offlineCutoff) ? 'online' : 'offline';
    }));

    // Device selector setup, with gray-out for offline
    const deviceSelect = document.getElementById('deviceSelect');
    deviceSelect.innerHTML = '';

    // Get last selected device from localStorage
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
        opt.style.color = '#aaa'; // gray out text
        opt.style.background = '#f4f4f4';
      }
      deviceSelect.appendChild(opt);
    });

    deviceSelect.value = DEVICE;
    deviceSelect.addEventListener('change', e => {
      DEVICE = e.target.value;
      localStorage.setItem('selectedDevice', DEVICE);
      document.getElementById('latest').innerHTML = '';
      trail = []; polyline.setLatLngs([]);
      initCharts(); updateCharts().then(() => { initMap(); poll(); });
      updateMaintenanceStatus();
      setupMaintenanceHandlers();
    });

    // Persist device even on page refresh
    localStorage.setItem('selectedDevice', DEVICE);

    initCharts(); updateCharts().then(() => { initMap(); poll(); });

    // CSV EXPORT BUTTON handler (now fetches ALL for date range!)
    const dlBtn = document.getElementById('dlBtn');
    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = "Downloading...";

        let startRaw = document.getElementById('start')?.value;
        let endRaw = document.getElementById('end')?.value;
        let start = null, end = null;
        if (startRaw) {
          start = new Date(startRaw + 'T00:00:00Z').getTime();
        }
        if (endRaw) {
          end = new Date(endRaw + 'T23:59:59.999Z').getTime();
        }

        // PATCH: Use fetchAllUbidotsVar to get all points!
        const rowsBySensor = await Promise.all(
          SENSORS.map(s => fetchAllUbidotsVar(DEVICE, s.id, start, end))
        );
        const maxLen = Math.max(...rowsBySensor.map(r => r.length));
        if (maxLen === 0) {
          alert("No data available to export for this device.");
          dlBtn.disabled = false;
          dlBtn.textContent = "Download";
          return;
        }
        let header = ['Time'].concat(SENSORS.map(s => s.label));
        let csv = [header.join(',')];

        for (let i = 0; i < maxLen; i++) {
          let t = rowsBySensor[0][i]?.created_at || '';
          let row = [t ? new Date(t).toLocaleString() : ''];
          for (let s = 0; s < SENSORS.length; s++) {
            row.push(rowsBySensor[s][i]?.value ?? '');
          }
          csv.push(row.join(','));
        }

        const blob = new Blob([csv.join('\r\n')], {type: 'text/csv'});
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${DEVICE}_data_${(new Date).toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        dlBtn.disabled = false;
        dlBtn.textContent = "Download";
      });
    }

    // Maintenance logic setup
    updateMaintenanceStatus();
    setupMaintenanceHandlers();
    setInterval(() => {
      updateMaintenanceStatus();
      setupMaintenanceHandlers();
    }, 60 * 60 * 1000);
  });
})();
