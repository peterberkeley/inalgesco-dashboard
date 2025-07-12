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
  const CONFIG_DEVICE = "config";
  const CONFIG_VARIABLE = "sensor_map";
  const CONFIG_URL = `https://industrial.api.ubidots.com/api/v1.6/devices/${CONFIG_DEVICE}/${CONFIG_VARIABLE}/values?page_size=1&token=${UBIDOTS_TOKEN}`;

  const POLL_MS = 10000, HIST = 50, TRAIL = 50;
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = 'skycafe-1';

  // SENSOR_MAP will be populated from Ubidots context
  let SENSOR_MAP = {};

  // Dynamic slot labels and colors
  const SENSOR_COLORS = [COLORS.primary, COLORS.secondary, COLORS.accent, "#8b5cf6", "#10b981"];
  let DALLAS_LIST = [];  // List of sorted sensor addresses for this truck

  // --- Fetch mapping/calibration config from Ubidots context
  async function fetchDallasAddresses(dev) {
  try {
    const url = `https://industrial.api.ubidots.com/api/v1.6/devices/${dev}/variables?token=${UBIDOTS_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const js = await res.json();
    return js.results
      .map(v => v.label)
      .filter(lbl => /^[0-9a-fA-F]{16}$/.test(lbl))
      .sort();
  } catch {
    return [];
  }
}

  // --- Dynamic SENSORS table for up to 5 sensors (sorted)
  function buildSensorSlots() {
    // Get up to 5 addresses for the current device, sorted
    const mapped = SENSOR_MAP[DEVICE] || {};
    const allAddr = DALLAS_LIST.slice(0,5); // Alphabetical, up to 5
    // Fill up to 5
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

  // --- Fetch last N values for any sensor address
  async function fetchUbidotsVar(dev, variable, limit = 1) {
    let url = `https://industrial.api.ubidots.com/api/v1.6/devices/${dev}/${variable}/values?page_size=${limit}`;
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

  // --- PATCH: Dynamic updateCharts for up to 5 sensor addresses ---
  async function updateCharts(SENSORS) {
    await Promise.all(SENSORS.map(async (s, idx) => {
      if (!s.address) return;
      const rows = await fetchUbidotsVar(DEVICE, s.address, HIST);
      if (!rows.length) return;
      s.chart.data.labels    = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true }));
      s.chart.data.datasets[0].data = rows.map(r => {
        let val = parseFloat(r.value);
        if (typeof s.calibration === 'number') val += s.calibration;
        return isNaN(val) ? null : val;
      });
      s.chart.update();
    }));
  }

  // --- PATCH: Live Table/Display for dynamic sensor slots ---
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

  // ...maintenance/CSV/selector logic is below (unchanged, but will use dynamic SENSORS)...
  // === PATCHED: poll sets ts from any available variable ===
  async function poll(SENSORS) {
    // Get latest GPS and ICCID
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

    // Dynamic sensor readings
    let readings = {};
    await Promise.all(SENSORS.filter(s=>s.address).map(async s => {
      const vals = await fetchUbidotsVar(DEVICE, s.address, 1);
      if (vals.length && vals[0].value != null) readings[s.address] = parseFloat(vals[0].value);
    }));

    // Fetch signal, volt, etc.
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

  // === PATCHED: CSV Export for all dynamic sensors ===
  async function csvExport(SENSORS) {
    const dlBtn = document.getElementById('dlBtn');
    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = "Downloading...";
        let startRaw = document.getElementById('start')?.value;
        let endRaw = document.getElementById('end')?.value;
        let start = null, end = null;
        if (startRaw) start = new Date(startRaw + 'T00:00:00Z').getTime();
        if (endRaw) end = new Date(endRaw + 'T23:59:59.999Z').getTime();
        // Fetch all points for each dynamic sensor
        const rowsBySensor = await Promise.all(
          SENSORS.map(s =>
            s.address ? fetchAllUbidotsVar(DEVICE, s.address, start, end) : Promise.resolve([])
          )
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
  }

  // === Device selector and initialization ===
  document.addEventListener('DOMContentLoaded', async () => {
    // Fetch admin mapping and device list
    SENSOR_MAP = await fetchSensorMapConfig();

    // Utility to check device "last activity"
    async function getDeviceLastTimestamp(dev) {
      try {
        const url = `https://industrial.api.ubidots.com/api/v1.6/devices/${dev}/`;
        const res = await fetch(url, { headers: { 'X-Auth-Token': UBIDOTS_TOKEN } });
        if (!res.ok) return 0;
        const js = await res.json();
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
      // Update dynamic sensor list for new truck
      DALLAS_LIST = await fetchDallasAddresses(DEVICE);
      const SENSORS = buildSensorSlots();
      initCharts(SENSORS);
      updateCharts(SENSORS).then(() => { initMap(); poll(SENSORS); });
      csvExport(SENSORS);
      updateMaintenanceStatus();
      setupMaintenanceHandlers();
    });

    // Initial fetch of dynamic sensors
    DALLAS_LIST = await fetchDallasAddresses(DEVICE);
    const SENSORS = buildSensorSlots();
    initCharts(SENSORS);
    updateCharts(SENSORS).then(() => { initMap(); poll(SENSORS); });
    csvExport(SENSORS);

    // --- Maintenance logic, CSV, handlers, etc (no change) ---
    // (Copy-paste the rest of your existing maintenance/handlers logic as before,
    // they will now reference the dynamic SENSORS array if needed.)

    // Maintenance countdown logic (unchanged)
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
    updateMaintenanceStatus();
    setupMaintenanceHandlers();
    setInterval(() => {
      updateMaintenanceStatus();
      setupMaintenanceHandlers();
    }, 60 * 60 * 1000);
  });
})();
